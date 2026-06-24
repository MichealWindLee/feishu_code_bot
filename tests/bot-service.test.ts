import { describe, expect, it } from "vitest";
import { BotService } from "../src/bot/bot-service.js";
import { SqliteStateStore } from "../src/store/sqlite-state-store.js";
import type { AppConfig } from "../src/config/types.js";
import type {
  CodexDriver,
  CodexEvent,
  CodexThread,
  InterruptTurnInput,
  ResolveApprovalInput,
  StartThreadInput,
  StartTurnInput,
} from "../src/codex/types.js";
import type {
  FeishuGateway,
  FeishuInboundEvent,
  FeishuMessagePort,
  ReplyTarget,
  SendResult,
} from "../src/feishu/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("BotService", () => {
  it("runs the main prompt flow with turn/start semantics", async () => {
    const { service, messages, codex } = makeHarness();

    await service.handleEvent(message("hello codex"));
    await service.waitForIdle();

    expect(codex.startedThreads).toHaveLength(1);
    expect(codex.turnInputs.map((input) => input.text)).toEqual(["hello codex"]);
    expect(messages.cards).toHaveLength(1);
    expect(messages.cardUpdates.length).toBeGreaterThan(0);
    expect(messages.markdown.at(-1)).toBe("done");
  });

  it("sends prompt accepted feedback only when debug is enabled", async () => {
    const { service, messages } = makeHarness(undefined, { debugPromptAcceptedFeedback: true });

    await service.handleEvent(message("hello codex"));
    await service.waitForIdle();

    expect(messages.markdown[0]).toContain("已收到");
  });

  it("renders turn status cards from plan and item events", async () => {
    const { service, messages } = makeHarness([
      { type: "turn_started", threadId: "thread-1", turnId: "turn-1" },
      {
        type: "plan_updated",
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: null,
        steps: [{ step: "Run tests", status: "inProgress" }],
      },
      {
        type: "item_started",
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "item-1",
          type: "command_execution",
          title: "pnpm test",
          command: "pnpm test",
          status: "inProgress",
        },
      },
      {
        type: "item_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "item-1",
          type: "command_execution",
          title: "pnpm test",
          command: "pnpm test",
          status: "completed",
          exitCode: 0,
        },
      },
      { type: "diff_updated", threadId: "thread-1", turnId: "turn-1", diff: "", changedFiles: ["src/foo.ts"] },
      {
        type: "item_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "item-2", type: "agent_message", title: "Agent response", text: "final answer" },
      },
      { type: "turn_completed", threadId: "thread-1", turnId: "turn-1", status: "completed" },
    ]);

    await service.handleEvent(message("run tests"));
    await service.waitForIdle();

    const cardText = JSON.stringify([...messages.cards, ...messages.cardUpdates.map((update) => update.card)]);
    expect(cardText).toContain("Run tests");
    expect(cardText).toContain("pnpm test");
    expect(cardText).toContain("src/foo.ts");
    expect(messages.markdown.at(-1)).toBe("final answer");
  });

  it("blocks ordinary messages when a turn is active", async () => {
    const { service, store, messages } = makeHarness();
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      codexThreadId: "thread-1",
      activeTurnId: "turn-1",
      lastChatId: "chat-1",
      updatedAt: Date.now(),
    });

    await service.handleEvent(message("another task"));
    await service.waitForIdle();

    expect(messages.markdown.at(-1)).toContain("already running");
  });

  it("stores and resolves approval requests", async () => {
    const { service, messages, codex } = makeHarness([
      {
        type: "approval_requested",
        approval: {
          kind: "command",
          requestId: 42,
          threadId: "thread-1",
          turnId: "turn-1",
          title: "Run command",
          body: "Command: pnpm test",
          raw: { requestId: 42, params: {} },
        },
      },
      { type: "turn_completed", threadId: "thread-1", turnId: "turn-1", status: "completed" },
    ]);

    await service.handleEvent(message("please test"));
    await service.waitForIdle();
    const approvalLine = messages.markdown.find((text) => text.includes("/approve"));
    expect(approvalLine).toBeTruthy();
    const approvalId = approvalLine?.match(/\/approve ([a-z0-9]+)/)?.[1];
    expect(approvalId).toBeTruthy();

    await service.handleEvent(message(`/approve ${approvalId}`));
    await service.waitForIdle();

    expect(codex.resolvedApprovals).toEqual([
      expect.objectContaining({ approved: true, requestId: 42 }),
    ]);
  });

  it("acks Feishu events before a slow Codex turn completes", async () => {
    const release = deferred<void>();
    const { service, codex } = makeHarness(async function* (input) {
      yield { type: "turn_started", threadId: input.threadId, turnId: "turn-1" };
      await release.promise;
      yield { type: "agent_delta", threadId: input.threadId, turnId: "turn-1", delta: "done" };
      yield { type: "turn_completed", threadId: input.threadId, turnId: "turn-1", status: "completed" };
    });

    await expect(
      Promise.race([service.handleEvent(message("slow task")).then(() => "acked"), delay(20).then(() => "timeout")]),
    ).resolves.toBe("acked");

    await waitUntil(() => codex.turnInputs.length === 1);
    release.resolve();
    await service.waitForIdle();
  });

  it("can process /stop while a Codex turn is still running", async () => {
    const release = deferred<void>();
    const { service, codex, messages, store } = makeHarness(async function* (input) {
      yield { type: "turn_started", threadId: input.threadId, turnId: "turn-1" };
      await release.promise;
      yield { type: "turn_completed", threadId: input.threadId, turnId: "turn-1", status: "completed" };
    });

    await service.handleEvent(message("long task"));
    await waitUntil(() => codex.turnInputs.length === 1);
    await waitUntil(async () => (await store.getCurrentSession("u1"))?.activeTurnId === "turn-1");

    await service.handleEvent(message("/stop"));
    await waitUntil(() => codex.interruptedTurns.length === 1);

    expect(codex.interruptedTurns[0]).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(messages.markdown.at(-1)).toContain("Stopped");
    release.resolve();
    await service.waitForIdle();
  });
});

type FakeCodexEvents = CodexEvent[] | ((input: StartTurnInput) => AsyncIterable<CodexEvent>);

function makeHarness(events?: FakeCodexEvents, botOverrides: Partial<AppConfig["bot"]> = {}) {
  const config = testConfig(botOverrides);
  const gateway = new FakeGateway();
  const messages = new FakeMessages();
  const codex = new FakeCodex(events);
  const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), "feishu-code-bot-")), "state.sqlite"));
  const service = new BotService(config, gateway, messages, codex, store);
  return { service, gateway, messages, codex, store };
}

function testConfig(botOverrides: Partial<AppConfig["bot"]> = {}): AppConfig {
  return {
    feishu: {
      appId: "app",
      appSecret: "secret",
      botOpenId: "bot",
      allowedUsers: ["u1"],
      allowedChats: [],
    },
    projects: [{ key: "bot", name: "Bot", path: process.cwd(), sandbox: "workspace-write" }],
    codex: {
      binaryPath: "codex",
      defaultSandbox: "workspace-write",
      defaultApprovalPolicy: "on-request",
    },
    storage: { sqlitePath: ":memory:" },
    bot: {
      approvalTtlMs: 60_000,
      eventDedupTtlMs: 60_000,
      debugPromptAcceptedFeedback: false,
      ...botOverrides,
    },
  };
}

function message(content: string): FeishuInboundEvent {
  return {
    kind: "message",
    eventId: `event-${content}-${Math.random()}`,
    messageId: `message-${Math.random()}`,
    chatId: "chat-1",
    chatType: "p2p",
    senderId: "u1",
    content,
    mentionedBot: false,
    mentions: [],
    resources: [],
    createTime: Date.now(),
  };
}

class FakeGateway implements FeishuGateway {
  handler: ((event: FeishuInboundEvent) => void | Promise<void>) | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onEvent(handler: (event: FeishuInboundEvent) => void | Promise<void>): void {
    this.handler = handler;
  }
}

class FakeMessages implements FeishuMessagePort {
  markdown: string[] = [];
  cards: object[] = [];
  cardUpdates: Array<{ messageId: string; card: object }> = [];

  async sendMarkdown(_target: ReplyTarget, markdown: string): Promise<SendResult> {
    this.markdown.push(markdown);
    return { messageId: `sent-${this.markdown.length}` };
  }

  async sendCard(_target: ReplyTarget, card: object): Promise<SendResult> {
    this.cards.push(card);
    return { messageId: `card-${this.cards.length}` };
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    this.cardUpdates.push({ messageId, card });
  }
}

class FakeCodex implements CodexDriver {
  startedThreads: StartThreadInput[] = [];
  turnInputs: StartTurnInput[] = [];
  interruptedTurns: InterruptTurnInput[] = [];
  resolvedApprovals: ResolveApprovalInput[] = [];

  constructor(private readonly events?: FakeCodexEvents) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async startThread(input: StartThreadInput): Promise<CodexThread> {
    this.startedThreads.push(input);
    return { id: "thread-1" };
  }

  async resumeThread(): Promise<CodexThread> {
    return { id: "thread-1" };
  }

  async *startTurn(input: StartTurnInput): AsyncIterable<CodexEvent> {
    this.turnInputs.push(input);
    const events: AsyncIterable<CodexEvent> | Iterable<CodexEvent> = this.events
      ? typeof this.events === "function"
        ? this.events(input)
        : this.events
      : ([
        { type: "turn_started", threadId: input.threadId, turnId: "turn-1" },
        { type: "agent_delta", threadId: input.threadId, turnId: "turn-1", delta: "done" },
        { type: "turn_completed", threadId: input.threadId, turnId: "turn-1", status: "completed" },
      ] satisfies CodexEvent[]);
    for await (const event of events) yield event;
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.interruptedTurns.push(input);
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    this.resolvedApprovals.push(input);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await delay(5);
  }
}
