import { randomUUID } from "node:crypto";
import {
  query,
  type Options,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../shared/async-queue.js";
import type { AppConfig } from "../config/types.js";
import type {
  AgentMetadata,
  AgentRunEvent,
  AgentSession,
  CodeAgentDriver,
  CreateAgentSessionInput,
  InterruptAgentRunInput,
  ResolveAgentApprovalInput,
  ResolveAgentUserInputInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
} from "../agent/types.js";
import { ClaudeCodeEventMapper } from "./events.js";
import { ClaudeCodeInteractions } from "./interactions.js";
import { toClaudePermissionMode, toClaudeSandbox } from "./permissions.js";

type ActiveQuery = {
  query: Query;
  abortController: AbortController;
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
  private readonly activeQueries = new Map<string, ActiveQuery>();
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
    for (const activeQuery of this.activeQueries.values()) {
      activeQuery.abortController.abort();
      activeQuery.query.close();
    }
    this.activeQueries.clear();
    this.eventMapper.clear();
    this.interactions.rejectPending(new Error("Claude Code driver stopped"));
  }

  async createSession(_input: CreateAgentSessionInput): Promise<AgentSession> {
    return { id: randomUUID(), resumeSupported: true };
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession> {
    this.loadedSessions.add(input.sessionId);
    return { id: input.sessionId, resumeSupported: true };
  }

  async *startRun(input: StartAgentRunInput): AsyncIterable<AgentRunEvent> {
    const runId = randomUUID();
    const queue = new AsyncQueue<AgentRunEvent>();
    queue.push({ type: "run_started", sessionId: input.sessionId, runId });

    const abortController = new AbortController();
    const queryInstance = query({
      prompt: input.text,
      options: this.queryOptions(input, runId, queue, abortController),
    });
    this.activeQueries.set(runId, { query: queryInstance, abortController });
    void this.consumeQuery(input.sessionId, runId, queryInstance, queue);

    for await (const event of queue) yield event;
  }

  async interruptRun(input: InterruptAgentRunInput): Promise<void> {
    this.activeQueries.get(input.runId)?.abortController.abort();
  }

  async resolveApproval(input: ResolveAgentApprovalInput): Promise<void> {
    await this.interactions.resolveApproval(input);
  }

  async resolveUserInput(input: ResolveAgentUserInputInput): Promise<void> {
    await this.interactions.resolveUserInput(input);
  }

  private queryOptions(
    input: StartAgentRunInput,
    runId: string,
    queue: AsyncQueue<AgentRunEvent>,
    abortController: AbortController,
  ): Options {
    const wasLoaded = this.loadedSessions.has(input.sessionId);
    this.loadedSessions.add(input.sessionId);
    return {
      abortController,
      cwd: input.project.path,
      model: input.project.model ?? this.config.agent.model,
      pathToClaudeCodeExecutable: this.config.agent.binaryPath,
      sessionId: wasLoaded ? undefined : input.sessionId,
      resume: wasLoaded ? input.sessionId : undefined,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: toClaudePermissionMode(input.project.approvalPolicy ?? this.config.agent.defaultApprovalPolicy),
      sandbox: toClaudeSandbox(input.project.sandbox ?? this.config.agent.defaultSandbox),
      includePartialMessages: false,
      canUseTool: this.interactions.canUseTool(input, runId, queue),
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [this.interactions.askUserQuestionHook(input, runId, queue)],
          },
        ],
      },
      stderr: (data) => {
        process.stderr.write(`[claude-code] ${data}`);
      },
    };
  }

  private async consumeQuery(
    sessionId: string,
    runId: string,
    queryInstance: Query,
    queue: AsyncQueue<AgentRunEvent>,
  ): Promise<void> {
    try {
      let queueClosed = false;
      for await (const message of queryInstance) {
        if (queueClosed) continue;
        const events = this.eventMapper.eventsFromMessage(sessionId, runId, message);
        for (const event of events) queue.push(event);
        if (events.some((event) => event.type === "run_completed")) {
          queue.close();
          queueClosed = true;
        }
      }
      queue.close();
    } catch (error) {
      queue.throw(error instanceof Error ? error : new Error(String(error)));
      this.interactions.rejectPendingForRun(runId, error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeQueries.delete(runId);
      this.interactions.rejectPendingForRun(runId, new Error("Claude Code run ended before the request was resolved"));
      this.eventMapper.clearRun(runId);
    }
  }
}
