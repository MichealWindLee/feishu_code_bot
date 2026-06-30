import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotService } from "../src/bot/bot-service.js";
import type {
  AgentCapabilities,
  AgentRunEvent,
  AgentSession,
  CodeAgentDriver,
  CreateAgentSessionInput,
  InterruptAgentRunInput,
  ResolveAgentApprovalInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
} from "../src/agent/types.js";
import { SqliteStateStore } from "../src/store/sqlite-state-store.js";
import type { AppConfig } from "../src/config/types.js";
import type {
  FeishuGateway,
  FeishuInboundEvent,
  FeishuMessagePort,
  ReplyTarget,
  SendResult,
} from "../src/feishu/types.js";

describe("BotService", () => {
  it("runs the main prompt flow with agent run semantics", async () => {
    const { service, messages, agent } = makeHarness();

    await service.handleEvent(message("hello agent"));
    await service.waitForIdle();

    expect(agent.createdSessions).toHaveLength(1);
    expect(agent.runInputs.map((input) => input.text)).toEqual(["hello agent"]);
    expect(messages.cards).toHaveLength(1);
    expect(messages.cardUpdates.length).toBeGreaterThan(0);
    expect(messages.markdown.at(-1)).toBe("done");
  });

  it("sends prompt accepted feedback only when debug is enabled", async () => {
    const { service, messages } = makeHarness(undefined, { debugPromptAcceptedFeedback: true });

    await service.handleEvent(message("hello agent"));
    await service.waitForIdle();

    expect(messages.markdown[0]).toContain("已收到");
    expect(messages.markdown[0]).toContain("Test Agent");
  });

  it("renders low-noise run status cards from plan and file changes", async () => {
    const { service, messages } = makeHarness([
      { type: "run_started", sessionId: "session-1", runId: "run-1" },
      {
        type: "plan_updated",
        sessionId: "session-1",
        runId: "run-1",
        explanation: null,
        steps: [{ step: "Run tests", status: "inProgress" }],
      },
      {
        type: "item_started",
        sessionId: "session-1",
        runId: "run-1",
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
        sessionId: "session-1",
        runId: "run-1",
        item: {
          id: "item-1",
          type: "command_execution",
          title: "pnpm test",
          command: "pnpm test",
          status: "completed",
          exitCode: 0,
        },
      },
      { type: "diff_updated", sessionId: "session-1", runId: "run-1", diff: "", changedFiles: ["src/foo.ts"] },
      { type: "diff_updated", sessionId: "session-1", runId: "run-1", diff: "", changedFiles: ["src/foo.ts"] },
      {
        type: "item_completed",
        sessionId: "session-1",
        runId: "run-1",
        item: { id: "item-2", type: "agent_message", title: "Agent response", text: "final answer" },
      },
      { type: "run_completed", sessionId: "session-1", runId: "run-1", status: "completed" },
    ]);

    await service.handleEvent(message("run tests"));
    await service.waitForIdle();

    const cardText = JSON.stringify([...messages.cards, ...messages.cardUpdates.map((update) => update.card)]);
    expect(cardText).toContain("Run tests");
    expect(cardText).toContain("命令 1 个");
    expect(cardText).toContain("src/foo.ts");
    expect(cardText).not.toContain("正在执行命令");
    expect(cardText).not.toContain("pnpm test");
    expect(cardText).not.toContain("最近活动");
    expect(cardText).not.toContain("Turn");
    expect(messages.cardUpdates).toHaveLength(4);
    expect(messages.markdown.at(-1)).toBe("final answer");
  });

  it("renders commentary as stage feedback without mixing it into the final reply", async () => {
    const { service, messages } = makeHarness([
      { type: "run_started", sessionId: "session-1", runId: "run-1" },
      {
        type: "item_started",
        sessionId: "session-1",
        runId: "run-1",
        item: {
          id: "item-commentary",
          type: "agent_message",
          title: "Agent response",
          messagePhase: "commentary",
          text: "",
        },
      },
      {
        type: "agent_delta",
        sessionId: "session-1",
        runId: "run-1",
        itemId: "item-commentary",
        messagePhase: "commentary",
        delta: "我先看一下代码结构。",
      },
      {
        type: "item_completed",
        sessionId: "session-1",
        runId: "run-1",
        item: {
          id: "item-commentary",
          type: "agent_message",
          title: "Agent response",
          messagePhase: "commentary",
          text: "我先看一下代码结构。",
        },
      },
      {
        type: "item_completed",
        sessionId: "session-1",
        runId: "run-1",
        item: {
          id: "item-final",
          type: "agent_message",
          title: "Agent response",
          messagePhase: "final_answer",
          text: "final answer",
        },
      },
      { type: "run_completed", sessionId: "session-1", runId: "run-1", status: "completed" },
    ]);

    await service.handleEvent(message("explain progress"));
    await service.waitForIdle();

    const cardText = JSON.stringify([...messages.cards, ...messages.cardUpdates.map((update) => update.card)]);
    expect(cardText).toContain("阶段反馈");
    expect(cardText).toContain("我先看一下代码结构。");
    expect(messages.markdown.at(-1)).toBe("final answer");
    expect(messages.markdown.join("\n")).not.toContain("我先看一下代码结构。");
  });

  it("does not reset accumulated commentary when item_started arrives after a delta", async () => {
    const { service, messages } = makeHarness([
      { type: "run_started", sessionId: "session-1", runId: "run-1" },
      {
        type: "agent_delta",
        sessionId: "session-1",
        runId: "run-1",
        itemId: "item-commentary",
        messagePhase: "commentary",
        delta: "我先看",
      },
      {
        type: "item_started",
        sessionId: "session-1",
        runId: "run-1",
        item: {
          id: "item-commentary",
          type: "agent_message",
          title: "Agent response",
          messagePhase: "commentary",
          text: "",
        },
      },
      {
        type: "agent_delta",
        sessionId: "session-1",
        runId: "run-1",
        itemId: "item-commentary",
        messagePhase: "commentary",
        delta: "代码。",
      },
      { type: "run_completed", sessionId: "session-1", runId: "run-1", status: "completed" },
    ]);

    await service.handleEvent(message("explain progress"));
    await service.waitForIdle();

    const cardText = JSON.stringify([...messages.cards, ...messages.cardUpdates.map((update) => update.card)]);
    expect(cardText).toContain("我先看代码。");
    expect(cardText).not.toContain("阶段反馈\\n代码。");
  });

  it("blocks ordinary messages when a run is active", async () => {
    const { service, store, messages } = makeHarness();
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      agentSessionId: "session-1",
      activeRunId: "run-1",
      lastChatId: "chat-1",
      updatedAt: Date.now(),
    });

    await service.handleEvent(message("another task"));
    await service.waitForIdle();

    expect(messages.markdown.at(-1)).toContain("already running");
  });

  it("stores and resolves approval requests", async () => {
    const { service, messages, agent } = makeHarness([
      {
        type: "approval_requested",
        approval: {
          kind: "command",
          requestId: 42,
          sessionId: "session-1",
          runId: "run-1",
          title: "Run command",
          body: "Command: pnpm test",
          raw: { requestId: 42, params: {} },
        },
      },
      { type: "run_completed", sessionId: "session-1", runId: "run-1", status: "completed" },
    ]);

    await service.handleEvent(message("please test"));
    await service.waitForIdle();
    const approvalLine = messages.markdown.find((text) => text.includes("/approve"));
    expect(approvalLine).toBeTruthy();
    const approvalId = approvalLine?.match(/\/approve ([a-z0-9]+)/)?.[1];
    expect(approvalId).toBeTruthy();

    await service.handleEvent(message(`/approve ${approvalId}`));
    await service.waitForIdle();

    expect(agent.resolvedApprovals).toEqual([
      expect.objectContaining({ approved: true, requestId: 42 }),
    ]);
  });

  it("does not store approval requests when the agent does not support approvals", async () => {
    const { service, messages, agent } = makeHarness(
      [
        {
          type: "approval_requested",
          approval: {
            kind: "command",
            requestId: 42,
            sessionId: "session-1",
            runId: "run-1",
            title: "Run command",
            body: "Command: pnpm test",
            raw: { requestId: 42, params: {} },
          },
        },
        { type: "run_completed", sessionId: "session-1", runId: "run-1", status: "completed" },
      ],
      {},
      { approvals: false },
    );

    await service.handleEvent(message("please test"));
    await service.waitForIdle();

    expect(messages.markdown.join("\n")).not.toContain("/approve");
    expect(messages.markdown.join("\n")).toContain("does not support remote approval");
    expect(agent.resolvedApprovals).toEqual([]);
  });

  it("acks Feishu events before a slow agent run completes", async () => {
    const release = deferred<void>();
    const { service, agent } = makeHarness(async function* (input) {
      yield { type: "run_started", sessionId: input.sessionId, runId: "run-1" };
      await release.promise;
      yield { type: "agent_delta", sessionId: input.sessionId, runId: "run-1", delta: "done" };
      yield { type: "run_completed", sessionId: input.sessionId, runId: "run-1", status: "completed" };
    });

    await expect(
      Promise.race([service.handleEvent(message("slow task")).then(() => "acked"), delay(20).then(() => "timeout")]),
    ).resolves.toBe("acked");

    await waitUntil(() => agent.runInputs.length === 1);
    release.resolve();
    await service.waitForIdle();
  });

  it("can process /stop while an agent run is still running", async () => {
    const release = deferred<void>();
    const { service, agent, messages, store } = makeHarness(async function* (input) {
      yield { type: "run_started", sessionId: input.sessionId, runId: "run-1" };
      await release.promise;
      yield { type: "run_completed", sessionId: input.sessionId, runId: "run-1", status: "completed" };
    });

    await service.handleEvent(message("long task"));
    await waitUntil(() => agent.runInputs.length === 1);
    await waitUntil(async () => (await store.getCurrentSession("u1"))?.activeRunId === "run-1");

    await service.handleEvent(message("/stop"));
    await waitUntil(() => agent.interruptedRuns.length === 1);

    expect(agent.interruptedRuns[0]).toEqual({ sessionId: "session-1", runId: "run-1" });
    expect(messages.markdown.at(-1)).toContain("Stopped");
    release.resolve();
    await service.waitForIdle();
  });

  it("reports unsupported /stop when the agent cannot interrupt runs", async () => {
    const { service, agent, messages, store } = makeHarness(undefined, {}, { interruptRun: false });
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      agentSessionId: "session-1",
      activeRunId: "run-1",
      lastChatId: "chat-1",
      updatedAt: Date.now(),
    });

    await service.handleEvent(message("/stop"));
    await service.waitForIdle();

    expect(agent.interruptedRuns).toEqual([]);
    expect(messages.markdown.at(-1)).toContain("does not support remote task interruption");
  });

  it("creates a fresh session instead of resuming when the agent cannot resume sessions", async () => {
    const { service, agent, store } = makeHarness(undefined, {}, { resumeSession: false });
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      agentSessionId: "old-session",
      activeRunId: null,
      lastChatId: "chat-1",
      updatedAt: Date.now(),
    });

    await service.handleEvent(message("new work after restart"));
    await service.waitForIdle();

    expect(agent.resumedSessions).toEqual([]);
    expect(agent.createdSessions).toHaveLength(1);
    expect(agent.runInputs[0].sessionId).toBe("session-1");
  });

  it("ends the current agent session and clears pending approvals", async () => {
    const { service, agent, messages, store } = makeHarness();
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      agentSessionId: "session-1",
      activeRunId: "run-1",
      lastChatId: "chat-1",
      updatedAt: Date.now(),
    });
    await store.savePendingApproval({
      approvalShortId: "a1",
      userOpenId: "u1",
      agentSessionId: "session-1",
      runId: "run-1",
      requestId: "9",
      approvalKind: "command",
      payloadJson: "{}",
      expiresAt: Date.now() + 60_000,
    });

    await service.handleEvent(message("/end"));
    await service.waitForIdle();

    expect(agent.interruptedRuns).toEqual([{ sessionId: "session-1", runId: "run-1" }]);
    expect(await store.getPendingApproval("a1")).toBeNull();
    expect(await store.getCurrentSession("u1")).toEqual(
      expect.objectContaining({
        agentSessionId: null,
        activeRunId: null,
      }),
    );
    expect(messages.markdown.at(-1)).toContain("Ended");
  });

  it("queues new prompts while an idle session is ending", async () => {
    const { service, agent, messages, store } = makeHarness();
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      agentSessionId: "old-session",
      activeRunId: null,
      lastChatId: "chat-1",
      updatedAt: Date.now(),
    });
    const releaseDelete = deferred<void>();
    const originalDeletePendingApprovals = store.deletePendingApprovalsForUser.bind(store);
    let deleteStarted = false;
    store.deletePendingApprovalsForUser = async (userOpenId: string) => {
      deleteStarted = true;
      await releaseDelete.promise;
      await originalDeletePendingApprovals(userOpenId);
    };

    await service.handleEvent(message("/end"));
    await waitUntil(() => deleteStarted);
    await service.handleEvent(message("start immediately"));
    await delay(10);

    expect(agent.runInputs).toHaveLength(0);

    releaseDelete.resolve();
    await service.waitForIdle();
    expect(agent.createdSessions).toHaveLength(1);
    expect(agent.runInputs.map((input) => input.text)).toEqual(["start immediately"]);
    expect(await store.getCurrentSession("u1")).toEqual(expect.objectContaining({ agentSessionId: "session-1" }));
    expect(messages.markdown.at(-1)).toBe("done");
  });
});

type FakeAgentEvents = AgentRunEvent[] | ((input: StartAgentRunInput) => AsyncIterable<AgentRunEvent>);

function makeHarness(
  events?: FakeAgentEvents,
  botOverrides: Partial<AppConfig["bot"]> = {},
  capabilityOverrides: Partial<AgentCapabilities> = {},
) {
  const config = testConfig(botOverrides);
  const gateway = new FakeGateway();
  const messages = new FakeMessages();
  const agent = new FakeAgent(events, capabilityOverrides);
  const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), "feishu-code-bot-")), "state.sqlite"));
  const service = new BotService(config, gateway, messages, agent, store);
  return { service, gateway, messages, agent, store };
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
    agent: {
      type: "codex",
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

class FakeAgent implements CodeAgentDriver {
  readonly metadata = { id: "fake-agent", displayName: "Test Agent" };
  readonly capabilities: AgentCapabilities = {
    resumeSession: true,
    interruptRun: true,
    approvals: true,
    planUpdates: true,
    fileDiffs: true,
  };

  createdSessions: CreateAgentSessionInput[] = [];
  resumedSessions: ResumeAgentSessionInput[] = [];
  runInputs: StartAgentRunInput[] = [];
  interruptedRuns: InterruptAgentRunInput[] = [];
  resolvedApprovals: ResolveAgentApprovalInput[] = [];

  constructor(private readonly events?: FakeAgentEvents, capabilityOverrides: Partial<AgentCapabilities> = {}) {
    this.capabilities = { ...this.capabilities, ...capabilityOverrides };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    this.createdSessions.push(input);
    return { id: `session-${this.createdSessions.length}`, resumeSupported: this.capabilities.resumeSession };
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession> {
    this.resumedSessions.push(input);
    return { id: input.sessionId, resumeSupported: this.capabilities.resumeSession };
  }

  async *startRun(input: StartAgentRunInput): AsyncIterable<AgentRunEvent> {
    this.runInputs.push(input);
    const events: AsyncIterable<AgentRunEvent> | Iterable<AgentRunEvent> = this.events
      ? typeof this.events === "function"
        ? this.events(input)
        : this.events
      : ([
        { type: "run_started", sessionId: input.sessionId, runId: "run-1" },
        { type: "agent_delta", sessionId: input.sessionId, runId: "run-1", delta: "done" },
        { type: "run_completed", sessionId: input.sessionId, runId: "run-1", status: "completed" },
      ] satisfies AgentRunEvent[]);
    for await (const event of events) yield event;
  }

  async interruptRun(input: InterruptAgentRunInput): Promise<void> {
    this.interruptedRuns.push(input);
  }

  async resolveApproval(input: ResolveAgentApprovalInput): Promise<void> {
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
