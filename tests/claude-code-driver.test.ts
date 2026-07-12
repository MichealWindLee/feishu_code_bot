import { beforeEach, describe, expect, it, vi } from "vitest";
import { query, type HookJSONOutput, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeDriver } from "../src/claude-code/claude-code-driver.js";
import type { AppConfig, ProjectConfig } from "../src/config/types.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

describe("ClaudeCodeDriver", () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("interrupts the active run through the long-lived session query", async () => {
    const queryMock = vi.mocked(query);
    const close = vi.fn();
    let interrupt!: ReturnType<typeof vi.fn>;
    let resolveInterrupted!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      resolveInterrupted = resolve;
    });

    queryMock.mockImplementationOnce((params) => {
      interrupt = vi.fn(async () => {
        resolveInterrupted();
      });
      return makeQuery(async function* () {
        await nextUserText(params.prompt);
        await interrupted;
        yield resultMessage("aborted");
      }, { close, interrupt });
    });

    const driver = new ClaudeCodeDriver(testConfig());
    const session = await driver.createSession({ project: testProject() });
    const iterator = driver.startRun({
      sessionId: session.id,
      project: testProject(),
      text: "stop me",
    })[Symbol.asyncIterator]();

    const started = (await iterator.next()).value;
    expect(started).toEqual({
      type: "run_started",
      sessionId: session.id,
      runId: expect.any(String),
    });

    await driver.interruptRun({ sessionId: session.id, runId: started.runId });

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "agent_delta",
      delta: "aborted",
    }));
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("routes Claude Code tool permissions through the current run", async () => {
    const queryMock = vi.mocked(query);
    let permissionResult: unknown;
    queryMock.mockImplementationOnce((params) => makeQuery(async function* () {
      await nextUserText(params.prompt);
      permissionResult = await params.options?.canUseTool?.(
        "Bash",
        { command: "pnpm test" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-1",
          title: "Run command",
          description: "Claude wants to run tests.",
        },
      );
      yield resultMessage("approved");
    }));

    const driver = new ClaudeCodeDriver(testConfig());
    const session = await driver.createSession({ project: testProject() });
    const iterator = driver.startRun({
      sessionId: session.id,
      project: testProject(),
      text: "run tests",
    })[Symbol.asyncIterator]();

    const started = (await iterator.next()).value;
    expect(started).toEqual({
      type: "run_started",
      sessionId: session.id,
      runId: expect.any(String),
    });

    const approvalEvent = (await iterator.next()).value;
    expect(approvalEvent).toEqual({
      type: "approval_requested",
      approval: expect.objectContaining({
        kind: "command",
        requestId: `${started.runId}:tool-1`,
        title: "Run command",
        body: expect.stringContaining("pnpm test"),
      }),
    });

    await driver.resolveApproval({
      kind: "command",
      requestId: approvalEvent.approval.requestId,
      approved: true,
      raw: approvalEvent.approval.raw,
    });

    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "agent_delta",
      delta: "approved",
    }));
    expect(permissionResult).toEqual(expect.objectContaining({ behavior: "allow" }));
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("routes AskUserQuestion through the current run", async () => {
    const queryMock = vi.mocked(query);
    let hookResult: HookJSONOutput | undefined;
    queryMock.mockImplementationOnce((params) => makeQuery(async function* () {
      await nextUserText(params.prompt);
      const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks[0];
      if (!hook) throw new Error("missing AskUserQuestion hook");
      hookResult = await hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "session",
          transcript_path: "/tmp/session.jsonl",
          cwd: testProject().path,
          tool_name: "AskUserQuestion",
          tool_use_id: "ask-1",
          tool_input: {
            questions: [
              {
                question: "Which framework should we use?",
                header: "Framework",
                options: [
                  { label: "React", description: "Use React." },
                  { label: "Vue", description: "Use Vue." },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        "ask-1",
        { signal: new AbortController().signal },
      );
      yield resultMessage("answered");
    }));

    const driver = new ClaudeCodeDriver(testConfig());
    const session = await driver.createSession({ project: testProject() });
    const iterator = driver.startRun({
      sessionId: session.id,
      project: testProject(),
      text: "ask user",
    })[Symbol.asyncIterator]();

    const started = (await iterator.next()).value;
    const questionEvent = (await iterator.next()).value;
    expect(questionEvent).toEqual({
      type: "user_input_requested",
      request: expect.objectContaining({
        requestId: `${started.runId}:ask-1`,
        title: "Claude Code 需要你的反馈",
        questions: [expect.objectContaining({ question: "Which framework should we use?" })],
      }),
    });

    await driver.resolveUserInput({
      requestId: questionEvent.request.requestId,
      response: { answers: { "Which framework should we use?": "React" } },
      raw: questionEvent.request.raw,
    });

    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "agent_delta",
      delta: "answered",
    }));
    expect(hookResult).toEqual({
      hookSpecificOutput: expect.objectContaining({
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: expect.objectContaining({
          answers: { "Which framework should we use?": "React" },
        }),
      }),
    });
  });

  it("reuses one session query for consecutive runs and closes only the run streams on results", async () => {
    const queryMock = vi.mocked(query);
    const close = vi.fn();
    const seenPrompts: string[] = [];
    queryMock.mockImplementationOnce((params) => makeQuery(async function* () {
      for await (const message of userMessages(params.prompt)) {
        const text = textFromUserMessage(message);
        seenPrompts.push(text);
        yield resultMessage(`done: ${text}`);
      }
    }, { close }));

    const driver = new ClaudeCodeDriver(testConfig());
    const project = testProject();
    const session = await driver.createSession({ project });

    const first = driver.startRun({ sessionId: session.id, project, text: "first" })[Symbol.asyncIterator]();
    await first.next();
    expect((await first.next()).value).toEqual(expect.objectContaining({ type: "agent_delta", delta: "done: first" }));
    expect((await first.next()).value).toEqual(expect.objectContaining({ type: "run_completed" }));
    expect(await first.next()).toEqual({ value: undefined, done: true });

    const second = driver.startRun({ sessionId: session.id, project, text: "second" })[Symbol.asyncIterator]();
    await second.next();
    expect((await second.next()).value).toEqual(expect.objectContaining({ type: "agent_delta", delta: "done: second" }));
    expect((await second.next()).value).toEqual(expect.objectContaining({ type: "run_completed" }));
    expect(await second.next()).toEqual({ value: undefined, done: true });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(seenPrompts).toEqual(["first", "second"]);
    expect(close).not.toHaveBeenCalled();

    await driver.disposeSession({ sessionId: session.id, project });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent runs on the same session connection", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockImplementationOnce(() => makeQuery(async function* () {
      await new Promise<void>(() => undefined);
    }));

    const driver = new ClaudeCodeDriver(testConfig());
    const project = testProject();
    const session = await driver.createSession({ project });

    await driver.startRun({ sessionId: session.id, project, text: "first" })[Symbol.asyncIterator]().next();

    const second = driver.startRun({ sessionId: session.id, project, text: "second" })[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toThrow("already has an active run");
    await driver.stop();
  });

  it("marks an active run interrupted when the session is disposed", async () => {
    const queryMock = vi.mocked(query);
    const close = vi.fn();
    queryMock.mockImplementationOnce(() => makeQuery(async function* () {
      await new Promise<void>(() => undefined);
    }, { close }));

    const driver = new ClaudeCodeDriver(testConfig());
    const project = testProject();
    const session = await driver.createSession({ project });
    const iterator = driver.startRun({ sessionId: session.id, project, text: "work" })[Symbol.asyncIterator]();

    await iterator.next();
    await driver.disposeSession({ sessionId: session.id, project });

    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "interrupted",
    }));
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes all session queries when stopped", async () => {
    const queryMock = vi.mocked(query);
    const close = vi.fn();
    queryMock.mockImplementation(() => makeQuery(async function* () {
      await new Promise<void>(() => undefined);
    }, { close }));

    const driver = new ClaudeCodeDriver(testConfig());
    const project = testProject();
    const firstSession = await driver.createSession({ project });
    const secondSession = await driver.createSession({ project });

    await driver.startRun({ sessionId: firstSession.id, project, text: "one" })[Symbol.asyncIterator]().next();
    await driver.startRun({ sessionId: secondSession.id, project, text: "two" })[Symbol.asyncIterator]().next();

    await driver.stop();

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

function makeQuery(factory: () => AsyncGenerator<SDKMessage, void>, overrides: Partial<Query> = {}): Query {
  const iterator = factory();
  return Object.assign(iterator, {
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setMcpPermissionModeOverride: vi.fn(),
    setModel: vi.fn(),
    applyFlagSettings: vi.fn(),
    initializationResult: vi.fn(),
    reinitialize: vi.fn(),
    supportedCommands: vi.fn(),
    supportedModels: vi.fn(),
    supportedAgents: vi.fn(),
    mcpServerStatus: vi.fn(),
    getContextUsage: vi.fn(),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(),
    readFile: vi.fn(),
    reloadPlugins: vi.fn(),
    reloadSkills: vi.fn(),
    accountInfo: vi.fn(),
    rewindFiles: vi.fn(),
    seedReadState: vi.fn(),
    reconnectMcpServer: vi.fn(),
    toggleMcpServer: vi.fn(),
    setMcpServers: vi.fn(),
    streamInput: vi.fn(),
    stopTask: vi.fn(),
    backgroundTasks: vi.fn(),
    close: vi.fn(),
  }, overrides) as unknown as Query;
}

async function nextUserText(prompt: string | AsyncIterable<SDKUserMessage>): Promise<string> {
  for await (const message of userMessages(prompt)) return textFromUserMessage(message);
  throw new Error("No user message received");
}

async function* userMessages(prompt: string | AsyncIterable<SDKUserMessage>): AsyncIterable<SDKUserMessage> {
  if (typeof prompt === "string") {
    yield {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
      parent_tool_use_id: null,
    };
    return;
  }
  yield* prompt;
}

function textFromUserMessage(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return "";
    const record = block as unknown as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? record.text : "";
  }).join("");
}

function resultMessage(result: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
  } as SDKMessage;
}

function testProject(): ProjectConfig {
  return {
    key: "bot",
    name: "Bot",
    path: process.cwd(),
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  };
}

function testConfig(): AppConfig {
  return {
    feishu: {
      appId: "app",
      appSecret: "secret",
      allowedUsers: [],
      allowedChats: [],
    },
    projects: [testProject()],
    agent: {
      type: "claude-code",
      defaultSandbox: "workspace-write",
      defaultApprovalPolicy: "on-request",
    },
    storage: { sqlitePath: ":memory:" },
    bot: {
      approvalTtlMs: 60_000,
      eventDedupTtlMs: 60_000,
      debugPromptAcceptedFeedback: false,
    },
  };
}
