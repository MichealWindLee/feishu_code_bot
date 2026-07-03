import { describe, expect, it, vi } from "vitest";
import { query, type HookJSONOutput, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeDriver } from "../src/claude-code/claude-code-driver.js";
import type { AppConfig, ProjectConfig } from "../src/config/types.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

describe("ClaudeCodeDriver", () => {
  it("aborts the active single-message query when interrupted", async () => {
    const queryMock = vi.mocked(query);
    let abortController: AbortController | undefined;
    queryMock.mockImplementationOnce((params) => {
      abortController = params.options?.abortController;
      return makeQuery(async function* () {
        await new Promise<void>((resolve) => {
          abortController?.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield resultMessage("aborted");
      });
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
    expect(abortController?.signal.aborted).toBe(false);

    await driver.interruptRun({ sessionId: session.id, runId: started.runId });

    expect(abortController?.signal.aborted).toBe(true);
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "agent_delta",
      delta: "aborted",
    }));
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("routes Claude Code tool permissions through approval events", async () => {
    const queryMock = vi.mocked(query);
    let permissionResult: unknown;
    queryMock.mockImplementationOnce((params) => makeQuery(async function* () {
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

    expect((await iterator.next()).value).toEqual({
      type: "run_started",
      sessionId: session.id,
      runId: expect.any(String),
    });

    const approvalEvent = (await iterator.next()).value;
    expect(approvalEvent).toEqual({
      type: "approval_requested",
      approval: expect.objectContaining({
        kind: "command",
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

  it("routes AskUserQuestion through user input events", async () => {
    const queryMock = vi.mocked(query);
    let hookResult: HookJSONOutput | undefined;
    queryMock.mockImplementationOnce((params) => makeQuery(async function* () {
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

    await iterator.next();
    const questionEvent = (await iterator.next()).value;
    expect(questionEvent).toEqual({
      type: "user_input_requested",
      request: expect.objectContaining({
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

  it("closes the run event stream as soon as Claude returns a result", async () => {
    const queryMock = vi.mocked(query);
    const close = vi.fn();
    queryMock.mockImplementationOnce(() => makeQuery(async function* () {
      yield resultMessage("done");
      await new Promise<void>(() => undefined);
    }, { close }));

    const driver = new ClaudeCodeDriver(testConfig());
    const session = await driver.createSession({ project: testProject() });
    const iterator = driver.startRun({
      sessionId: session.id,
      project: testProject(),
      text: "finish",
    })[Symbol.asyncIterator]();

    await iterator.next();
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "agent_delta",
      delta: "done",
    }));
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));

    const timeout = Symbol("timeout");
    const done = await Promise.race([
      iterator.next(),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 50)),
    ]);
    expect(done).toEqual({ value: undefined, done: true });
    expect(close).not.toHaveBeenCalled();
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
