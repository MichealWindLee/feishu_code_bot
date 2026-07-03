import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { AsyncQueue } from "../shared/async-queue.js";
import type { AppConfig, ProjectConfig } from "../config/types.js";
import { approvalResult, toApprovalRequest } from "./app-server-approvals.js";
import {
  extractChangedFilesFromDiff,
  readErrorMessage,
  readPlanSteps,
  readTurnId,
  readTurnStatus,
  summarizeItem,
} from "./app-server-events.js";
import type {
  AgentItemSummary,
  AgentMessagePhase,
  AgentMetadata,
  AgentRunEvent,
  AgentSession,
  CodeAgentDriver,
  InterruptAgentRunInput,
  ResolveAgentApprovalInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
} from "../agent/types.js";

type JsonRpcId = string | number;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type RpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export class CodexAppServerDriver implements CodeAgentDriver {
  readonly metadata: AgentMetadata;

  readonly capabilities = {
    resumeSession: true,
    interruptRun: true,
    approvals: true,
    planUpdates: true,
    fileDiffs: true,
  };

  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly turnQueues = new Map<string, AsyncQueue<AgentRunEvent>>();
  private readonly turnThreadIds = new Map<string, string>();
  private readonly bufferedTurnEvents = new Map<string, AgentRunEvent[]>();
  private readonly agentMessagePhases = new Map<string, AgentMessagePhase | null>();
  private initialized = false;

  constructor(private readonly config: AppConfig) {
    this.metadata = {
      id: "codex",
      displayName: config.agent.displayName ?? "Codex",
    };
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const binaryPath = this.config.agent.binaryPath?.trim();
    if (!binaryPath) throw new Error("Missing agent.binaryPath for Codex app-server driver");
    this.proc = spawn(binaryPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited with ${signal ?? code ?? "unknown"}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      for (const queue of this.turnQueues.values()) queue.throw(error);
      this.turnQueues.clear();
      this.turnThreadIds.clear();
      this.bufferedTurnEvents.clear();
      this.agentMessagePhases.clear();
      this.proc = null;
      this.initialized = false;
    });

    this.proc.stderr.on("data", (chunk) => {
      process.stderr.write(`[codex app-server] ${String(chunk)}`);
    });

    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "feishu_code_bot",
        title: `Feishu ${this.metadata.displayName} Bot`,
        version: "0.1.0",
      },
    });
    this.send({ method: "initialized", params: {} });
    this.initialized = true;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
    this.initialized = false;
  }

  async createSession(input: { project: ProjectConfig }): Promise<AgentSession> {
    await this.ensureStarted();
    const result = (await this.request("thread/start", threadParams(input.project, this.config))) as {
      thread?: { id?: string };
    };
    if (!result.thread?.id) throw new Error(`thread/start response missing thread id: ${JSON.stringify(result)}`);
    return { id: result.thread.id, resumeSupported: true };
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession> {
    await this.ensureStarted();
    const result = (await this.request("thread/resume", {
      threadId: input.sessionId,
      ...threadParams(input.project, this.config),
    })) as { thread?: { id?: string } };
    if (!result.thread?.id) throw new Error(`thread/resume response missing thread id: ${JSON.stringify(result)}`);
    return { id: result.thread.id, resumeSupported: true };
  }

  async *startRun(input: StartAgentRunInput): AsyncIterable<AgentRunEvent> {
    await this.ensureStarted();
    const result = (await this.request("turn/start", {
      threadId: input.sessionId,
      clientUserMessageId: input.clientUserMessageId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      cwd: input.project.path,
      approvalPolicy: input.project.approvalPolicy ?? this.config.agent.defaultApprovalPolicy,
      model: input.project.model ?? this.config.agent.model,
    })) as { turn?: { id?: string; status?: string } };

    const turnId = result.turn?.id;
    if (!turnId) throw new Error(`turn/start response missing turn id: ${JSON.stringify(result)}`);

    const queue = new AsyncQueue<AgentRunEvent>();
    this.turnQueues.set(turnId, queue);
    this.turnThreadIds.set(turnId, input.sessionId);
    queue.push({ type: "run_started", sessionId: input.sessionId, runId: turnId });
    this.flushBufferedTurnEvents(turnId, queue);

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      this.turnQueues.delete(turnId);
      this.turnThreadIds.delete(turnId);
    }
  }

  async interruptRun(input: InterruptAgentRunInput): Promise<void> {
    await this.ensureStarted();
    await this.request("turn/interrupt", {
      threadId: input.sessionId,
      turnId: input.runId,
    });
  }

  async resolveApproval(input: ResolveAgentApprovalInput): Promise<void> {
    await this.ensureStarted();
    const raw = input.raw as { method?: string; requestId?: JsonRpcId; params?: unknown };
    if (raw.requestId === undefined) throw new Error("Approval payload missing requestId");
    this.send({
      id: raw.requestId,
      result: approvalResult(input.kind, input.approved, raw.params),
    });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.proc || !this.initialized) await this.start();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
    });
  }

  private send(message: RpcMessage): void {
    if (!this.proc?.stdin.writable) throw new Error("codex app-server stdin is not writable");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch (error) {
      this.failAll(new Error(`Invalid JSON from codex app-server: ${line}`));
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.handleNotification(message);
  }

  private handleNotification(message: RpcMessage): void {
    const params = message.params as Record<string, unknown> | undefined;
    const turnId = typeof params?.turnId === "string" ? params.turnId : readTurnId(params);

    switch (message.method) {
      case "turn/started": {
        if (turnId) {
          this.pushTurnEvent(turnId, {
            type: "run_started",
            sessionId: String(params?.threadId ?? ""),
            runId: turnId,
          });
        }
        break;
      }
      case "item/agentMessage/delta": {
        if (turnId) {
          const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
          this.pushTurnEvent(turnId, {
            type: "agent_delta",
            sessionId: String(params?.threadId ?? ""),
            runId: turnId,
            itemId,
            messagePhase: itemId ? this.agentMessagePhases.get(itemId) : undefined,
            delta: String(params?.delta ?? ""),
          });
        }
        break;
      }
      case "turn/plan/updated": {
        if (turnId) {
          this.pushTurnEvent(turnId, {
            type: "plan_updated",
            sessionId: String(params?.threadId ?? ""),
            runId: turnId,
            explanation: typeof params?.explanation === "string" ? params.explanation : null,
            steps: readPlanSteps(params),
          });
        }
        break;
      }
      case "item/started": {
        if (turnId) {
          const item = summarizeItem((params as { item?: unknown } | undefined)?.item);
          this.rememberAgentMessagePhase(item);
          this.pushTurnEvent(turnId, {
            type: "item_started",
            sessionId: String(params?.threadId ?? ""),
            runId: turnId,
            item,
          });
        }
        break;
      }
      case "item/completed": {
        if (turnId) {
          const item = summarizeItem((params as { item?: unknown } | undefined)?.item);
          this.pushTurnEvent(turnId, {
            type: "item_completed",
            sessionId: String(params?.threadId ?? ""),
            runId: turnId,
            item,
          });
          if (item.type === "agent_message") this.agentMessagePhases.delete(item.id);
        }
        break;
      }
      case "turn/diff/updated": {
        if (turnId) {
          const diff = typeof params?.diff === "string" ? params.diff : "";
          this.pushTurnEvent(turnId, {
            type: "diff_updated",
            sessionId: String(params?.threadId ?? ""),
            runId: turnId,
            diff,
            changedFiles: extractChangedFilesFromDiff(diff),
          });
        }
        break;
      }
      case "warning": {
        this.pushWarningEvent(params);
        break;
      }
      case "turn/completed": {
        if (turnId) {
          const status = readTurnStatus(params);
          this.pushTurnEvent(turnId, {
            type: "run_completed",
            sessionId: String(params?.threadId ?? ""),
            runId: turnId,
            status,
          });
        }
        break;
      }
      case "error": {
        const error = new Error(readErrorMessage(params));
        const queue = turnId ? this.turnQueues.get(turnId) : undefined;
        if (queue) queue.throw(error);
        else if (turnId) this.pushTurnEvent(turnId, { type: "error", runId: turnId, message: error.message });
        else this.failAll(error);
        break;
      }
      default:
        break;
    }
  }

  private pushWarningEvent(params: Record<string, unknown> | undefined): void {
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const message = typeof params?.message === "string" ? params.message : "Codex warning";
    if (!threadId) {
      for (const queue of this.turnQueues.values()) queue.push({ type: "warning", message });
      return;
    }
    for (const [turnId, queue] of this.turnQueues.entries()) {
      if (this.turnThreadIds.get(turnId) === threadId) queue.push({ type: "warning", sessionId: threadId, message });
    }
  }

  private handleServerRequest(message: RpcMessage): void {
    if (!message.method || message.id === undefined) return;
    const approval = toApprovalRequest(message);
    if (!approval) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }

    if (!approval.runId) {
      this.send({
        id: message.id,
        result: approvalResult(approval.kind, false, (message.params as Record<string, unknown>) ?? {}),
      });
      return;
    }
    this.pushTurnEvent(approval.runId, { type: "approval_requested", approval });
  }

  private pushTurnEvent(turnId: string, event: AgentRunEvent): void {
    const queue = this.turnQueues.get(turnId);
    if (!queue) {
      const buffered = this.bufferedTurnEvents.get(turnId) ?? [];
      buffered.push(event);
      this.bufferedTurnEvents.set(turnId, buffered);
      return;
    }
    queue.push(event);
    if (event.type === "run_completed") queue.close();
  }

  private flushBufferedTurnEvents(turnId: string, queue: AsyncQueue<AgentRunEvent>): void {
    const buffered = this.bufferedTurnEvents.get(turnId);
    if (!buffered) return;
    this.bufferedTurnEvents.delete(turnId);
    for (const event of buffered) {
      queue.push(event);
      if (event.type === "run_completed") queue.close();
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const queue of this.turnQueues.values()) queue.throw(error);
    this.turnQueues.clear();
    this.turnThreadIds.clear();
    this.bufferedTurnEvents.clear();
    this.agentMessagePhases.clear();
  }

  private rememberAgentMessagePhase(item: AgentItemSummary): void {
    if (item.type === "agent_message") this.agentMessagePhases.set(item.id, item.messagePhase ?? null);
  }
}

function threadParams(project: ProjectConfig, config: AppConfig): Record<string, unknown> {
  return {
    cwd: project.path,
    approvalPolicy: project.approvalPolicy ?? config.agent.defaultApprovalPolicy,
    sandbox: project.sandbox ?? config.agent.defaultSandbox,
    model: project.model ?? config.agent.model,
    serviceName: "feishu-code-bot",
  };
}
