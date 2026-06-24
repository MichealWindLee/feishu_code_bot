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
  CodexDriver,
  CodexEvent,
  CodexThread,
  InterruptTurnInput,
  ResolveApprovalInput,
  ResumeThreadInput,
  StartThreadInput,
  StartTurnInput,
} from "./types.js";

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

export class CodexAppServerDriver implements CodexDriver {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly turnQueues = new Map<string, AsyncQueue<CodexEvent>>();
  private readonly turnThreadIds = new Map<string, string>();
  private readonly bufferedTurnEvents = new Map<string, CodexEvent[]>();
  private initialized = false;

  constructor(private readonly config: AppConfig) {}

  async start(): Promise<void> {
    if (this.proc) return;
    this.proc = spawn(this.config.codex.binaryPath, ["app-server", "--listen", "stdio://"], {
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
        title: "Feishu Codex Bot",
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

  async startThread(input: StartThreadInput): Promise<CodexThread> {
    await this.ensureStarted();
    const result = (await this.request("thread/start", threadParams(input.project, this.config))) as {
      thread?: { id?: string };
    };
    if (!result.thread?.id) throw new Error(`thread/start response missing thread id: ${JSON.stringify(result)}`);
    return { id: result.thread.id };
  }

  async resumeThread(threadId: string, input: ResumeThreadInput): Promise<CodexThread> {
    await this.ensureStarted();
    const result = (await this.request("thread/resume", {
      threadId,
      ...threadParams(input.project, this.config),
    })) as { thread?: { id?: string } };
    if (!result.thread?.id) throw new Error(`thread/resume response missing thread id: ${JSON.stringify(result)}`);
    return { id: result.thread.id };
  }

  async *startTurn(input: StartTurnInput): AsyncIterable<CodexEvent> {
    await this.ensureStarted();
    const result = (await this.request("turn/start", {
      threadId: input.threadId,
      clientUserMessageId: input.clientUserMessageId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      cwd: input.project.path,
      approvalPolicy: input.project.approvalPolicy ?? this.config.codex.defaultApprovalPolicy,
      model: input.project.model ?? this.config.codex.model,
    })) as { turn?: { id?: string; status?: string } };

    const turnId = result.turn?.id;
    if (!turnId) throw new Error(`turn/start response missing turn id: ${JSON.stringify(result)}`);

    const queue = new AsyncQueue<CodexEvent>();
    this.turnQueues.set(turnId, queue);
    this.turnThreadIds.set(turnId, input.threadId);
    queue.push({ type: "turn_started", threadId: input.threadId, turnId });
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

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    await this.ensureStarted();
    await this.request("turn/interrupt", {
      threadId: input.threadId,
      turnId: input.turnId,
    });
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
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
            type: "turn_started",
            threadId: String(params?.threadId ?? ""),
            turnId,
          });
        }
        break;
      }
      case "item/agentMessage/delta": {
        if (turnId) {
          this.pushTurnEvent(turnId, {
            type: "agent_delta",
            threadId: String(params?.threadId ?? ""),
            turnId,
            delta: String(params?.delta ?? ""),
          });
        }
        break;
      }
      case "turn/plan/updated": {
        if (turnId) {
          this.pushTurnEvent(turnId, {
            type: "plan_updated",
            threadId: String(params?.threadId ?? ""),
            turnId,
            explanation: typeof params?.explanation === "string" ? params.explanation : null,
            steps: readPlanSteps(params),
          });
        }
        break;
      }
      case "item/started": {
        if (turnId) {
          this.pushTurnEvent(turnId, {
            type: "item_started",
            threadId: String(params?.threadId ?? ""),
            turnId,
            item: summarizeItem((params as { item?: unknown } | undefined)?.item),
          });
        }
        break;
      }
      case "item/completed": {
        if (turnId) {
          this.pushTurnEvent(turnId, {
            type: "item_completed",
            threadId: String(params?.threadId ?? ""),
            turnId,
            item: summarizeItem((params as { item?: unknown } | undefined)?.item),
          });
        }
        break;
      }
      case "turn/diff/updated": {
        if (turnId) {
          const diff = typeof params?.diff === "string" ? params.diff : "";
          this.pushTurnEvent(turnId, {
            type: "diff_updated",
            threadId: String(params?.threadId ?? ""),
            turnId,
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
            type: "turn_completed",
            threadId: String(params?.threadId ?? ""),
            turnId,
            status,
          });
        }
        break;
      }
      case "error": {
        const error = new Error(readErrorMessage(params));
        const queue = turnId ? this.turnQueues.get(turnId) : undefined;
        if (queue) queue.throw(error);
        else if (turnId) this.pushTurnEvent(turnId, { type: "error", turnId, message: error.message });
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
      if (this.turnThreadIds.get(turnId) === threadId) queue.push({ type: "warning", threadId, message });
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

    if (!approval.turnId) {
      this.send({
        id: message.id,
        result: approvalResult(approval.kind, false, (message.params as Record<string, unknown>) ?? {}),
      });
      return;
    }
    this.pushTurnEvent(approval.turnId, { type: "approval_requested", approval });
  }

  private pushTurnEvent(turnId: string, event: CodexEvent): void {
    const queue = this.turnQueues.get(turnId);
    if (!queue) {
      const buffered = this.bufferedTurnEvents.get(turnId) ?? [];
      buffered.push(event);
      this.bufferedTurnEvents.set(turnId, buffered);
      return;
    }
    queue.push(event);
    if (event.type === "turn_completed") queue.close();
  }

  private flushBufferedTurnEvents(turnId: string, queue: AsyncQueue<CodexEvent>): void {
    const buffered = this.bufferedTurnEvents.get(turnId);
    if (!buffered) return;
    this.bufferedTurnEvents.delete(turnId);
    for (const event of buffered) {
      queue.push(event);
      if (event.type === "turn_completed") queue.close();
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const queue of this.turnQueues.values()) queue.throw(error);
    this.turnQueues.clear();
    this.turnThreadIds.clear();
    this.bufferedTurnEvents.clear();
  }
}

function threadParams(project: ProjectConfig, config: AppConfig): Record<string, unknown> {
  return {
    cwd: project.path,
    approvalPolicy: project.approvalPolicy ?? config.codex.defaultApprovalPolicy,
    sandbox: project.sandbox ?? config.codex.defaultSandbox,
    model: project.model ?? config.codex.model,
    serviceName: "feishu-code-bot",
  };
}
