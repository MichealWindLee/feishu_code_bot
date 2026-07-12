import { randomUUID } from "node:crypto";
import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../shared/async-queue.js";
import type { AppConfig } from "../config/types.js";
import type {
  AgentMetadata,
  AgentRunEvent,
  AgentSession,
  CodeAgentDriver,
  CreateAgentSessionInput,
  DisposeAgentSessionInput,
  InterruptAgentRunInput,
  ResolveAgentApprovalInput,
  ResolveAgentUserInputInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
} from "../agent/types.js";
import { ClaudeCodeEventMapper } from "./events.js";
import { ClaudeCodeInteractions, type ClaudeCodeInteractionRunContext } from "./interactions.js";
import { toClaudePermissionMode, toClaudeSandbox } from "./permissions.js";

type ActiveClaudeRun = ClaudeCodeInteractionRunContext;

type ClaudeCodeSessionConnection = {
  sessionId: string;
  query: Query;
  inputQueue: AsyncQueue<SDKUserMessage>;
  consumeTask: Promise<void>;
  currentRun?: ActiveClaudeRun;
  closed: boolean;
};

export class ClaudeCodeDriver implements CodeAgentDriver {
  readonly metadata: AgentMetadata;

  readonly capabilities = {
    resumeSession: true,
    interruptRun: true,
    approvals: true,
    planUpdates: false,
    fileDiffs: false,
    userInputRequests: true,
  };

  private readonly loadedSessions = new Set<string>();
  private readonly sessionConnections = new Map<string, ClaudeCodeSessionConnection>();
  private readonly runConnections = new Map<string, ClaudeCodeSessionConnection>();
  private readonly eventMapper = new ClaudeCodeEventMapper();
  private readonly interactions: ClaudeCodeInteractions;

  constructor(private readonly config: AppConfig) {
    this.metadata = {
      id: "claude-code",
      displayName: config.agent.displayName ?? "Claude Code",
    };
    this.interactions = new ClaudeCodeInteractions(this.metadata.displayName);
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    const error = new Error("Claude Code driver stopped");
    for (const connection of this.sessionConnections.values()) {
      this.closeConnection(connection, error);
    }
    this.sessionConnections.clear();
    this.runConnections.clear();
    this.eventMapper.clear();
    this.interactions.rejectPending(error);
  }

  async createSession(_input: CreateAgentSessionInput): Promise<AgentSession> {
    return { id: randomUUID(), resumeSupported: true };
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession> {
    this.loadedSessions.add(input.sessionId);
    return { id: input.sessionId, resumeSupported: true };
  }

  async disposeSession(input: DisposeAgentSessionInput): Promise<void> {
    const connection = this.sessionConnections.get(input.sessionId);
    if (!connection) return;
    this.closeConnection(connection, new Error("Claude Code session disposed"));
    this.sessionConnections.delete(input.sessionId);
  }

  async *startRun(input: StartAgentRunInput): AsyncIterable<AgentRunEvent> {
    const connection = this.ensureConnection(input);
    if (connection.currentRun) {
      throw new Error(`Claude Code session ${input.sessionId} already has an active run`);
    }

    const runId = randomUUID();
    const queue = new AsyncQueue<AgentRunEvent>();
    const activeRun: ActiveClaudeRun = { input, runId, queue };
    connection.currentRun = activeRun;
    this.runConnections.set(runId, connection);

    queue.push({ type: "run_started", sessionId: input.sessionId, runId });
    connection.inputQueue.push(toSdkUserMessage(input.text));

    for await (const event of queue) yield event;
  }

  async interruptRun(input: InterruptAgentRunInput): Promise<void> {
    const connection = this.runConnections.get(input.runId) ?? this.sessionConnections.get(input.sessionId);
    if (connection?.currentRun?.runId !== input.runId) return;
    await connection.query.interrupt();
  }

  async resolveApproval(input: ResolveAgentApprovalInput): Promise<void> {
    await this.interactions.resolveApproval(input);
  }

  async resolveUserInput(input: ResolveAgentUserInputInput): Promise<void> {
    await this.interactions.resolveUserInput(input);
  }

  private ensureConnection(input: StartAgentRunInput): ClaudeCodeSessionConnection {
    const existing = this.sessionConnections.get(input.sessionId);
    if (existing && !existing.closed) return existing;

    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const connection: ClaudeCodeSessionConnection = {
      sessionId: input.sessionId,
      query: undefined as unknown as Query,
      inputQueue,
      consumeTask: Promise.resolve(),
      closed: false,
    };
    const queryInstance = query({
      prompt: inputQueue,
      options: this.queryOptions(input, connection),
    });
    connection.query = queryInstance;
    connection.consumeTask = this.consumeConnection(connection);
    this.sessionConnections.set(input.sessionId, connection);
    return connection;
  }

  private queryOptions(
    input: StartAgentRunInput,
    connection: ClaudeCodeSessionConnection,
  ): Options {
    const wasLoaded = this.loadedSessions.has(input.sessionId);
    this.loadedSessions.add(input.sessionId);
    return {
      cwd: input.project.path,
      model: input.project.model ?? this.config.agent.model,
      pathToClaudeCodeExecutable: this.config.agent.binaryPath,
      sessionId: wasLoaded ? undefined : input.sessionId,
      resume: wasLoaded ? input.sessionId : undefined,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: toClaudePermissionMode(input.project.approvalPolicy ?? this.config.agent.defaultApprovalPolicy),
      sandbox: toClaudeSandbox(input.project.sandbox ?? this.config.agent.defaultSandbox),
      includePartialMessages: false,
      canUseTool: this.interactions.canUseTool(() => connection.currentRun),
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [this.interactions.askUserQuestionHook(() => connection.currentRun)],
          },
        ],
      },
      stderr: (data) => {
        process.stderr.write(`[claude-code] ${data}`);
      },
    };
  }

  private async consumeConnection(connection: ClaudeCodeSessionConnection): Promise<void> {
    try {
      for await (const message of connection.query) {
        const activeRun = connection.currentRun;
        if (!activeRun) continue;
        const events = this.eventMapper.eventsFromMessage(connection.sessionId, activeRun.runId, message);
        for (const event of events) activeRun.queue.push(event);
        if (events.some((event) => event.type === "run_completed")) {
          this.finishRun(connection, activeRun);
        }
      }
    } catch (error) {
      this.failActiveRun(connection, error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (connection.currentRun && !connection.closed) {
        this.failActiveRun(connection, new Error("Claude Code query ended before the run completed"));
      }
      this.cleanupConnection(connection);
    }
  }

  private finishRun(connection: ClaudeCodeSessionConnection, activeRun: ActiveClaudeRun): void {
    if (connection.currentRun !== activeRun) return;
    activeRun.queue.close();
    connection.currentRun = undefined;
    this.runConnections.delete(activeRun.runId);
    this.interactions.rejectPendingForRun(activeRun.runId, new Error("Claude Code run ended before the request was resolved"));
    this.eventMapper.clearRun(activeRun.runId);
  }

  private failActiveRun(connection: ClaudeCodeSessionConnection, error: Error): void {
    const activeRun = connection.currentRun;
    if (!activeRun) return;
    activeRun.queue.throw(error);
    connection.currentRun = undefined;
    this.runConnections.delete(activeRun.runId);
    this.interactions.rejectPendingForRun(activeRun.runId, error);
    this.eventMapper.clearRun(activeRun.runId);
  }

  private interruptActiveRun(connection: ClaudeCodeSessionConnection, error: Error): void {
    const activeRun = connection.currentRun;
    if (!activeRun) return;
    activeRun.queue.push({
      type: "run_completed",
      sessionId: connection.sessionId,
      runId: activeRun.runId,
      status: "interrupted",
    });
    activeRun.queue.close();
    connection.currentRun = undefined;
    this.runConnections.delete(activeRun.runId);
    this.interactions.rejectPendingForRun(activeRun.runId, error);
    this.eventMapper.clearRun(activeRun.runId);
  }

  private closeConnection(connection: ClaudeCodeSessionConnection, error: Error): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.inputQueue.close();
    connection.query.close();
    this.interruptActiveRun(connection, error);
  }

  private cleanupConnection(connection: ClaudeCodeSessionConnection): void {
    connection.closed = true;
    connection.inputQueue.close();
    if (this.sessionConnections.get(connection.sessionId) === connection) {
      this.sessionConnections.delete(connection.sessionId);
    }
  }
}

function toSdkUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}
