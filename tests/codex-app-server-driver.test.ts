import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerDriver } from "../src/codex/app-server-driver.js";
import type { AgentRunEvent } from "../src/agent/types.js";
import type { AppConfig } from "../src/config/types.js";

describe("CodexAppServerDriver", () => {
  let driver: CodexAppServerDriver | null = null;

  afterEach(async () => {
    await driver?.stop();
    driver = null;
  });

  it("speaks the app-server JSON-RPC subset and resolves approvals", async () => {
    const binaryPath = createFakeAppServer();
    const config = testConfig(binaryPath);
    config.agent.displayName = "Work Codex";
    driver = new CodexAppServerDriver(config);
    expect(driver.metadata).toEqual({ id: "codex", displayName: "Work Codex" });

    await driver.start();
    const session = await driver.createSession({ project: testProject() });
    expect(session).toEqual({ id: "thread-1", resumeSupported: true });
    await expect(driver.resumeSession({ sessionId: "thread-1", project: testProject() })).resolves.toEqual({
      id: "thread-1",
      resumeSupported: true,
    });

    const iterator = driver
      .startRun({
        sessionId: "thread-1",
        project: testProject(),
        text: "please test",
        clientUserMessageId: "message-1",
      })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({
      type: "run_started",
      sessionId: "thread-1",
      runId: "turn-1",
    });
    expect((await iterator.next()).value).toEqual({
      type: "plan_updated",
      sessionId: "thread-1",
      runId: "turn-1",
      explanation: null,
      steps: [{ step: "Run tests", status: "inProgress" }],
    });
    expect((await iterator.next()).value).toEqual({
      type: "item_started",
      sessionId: "thread-1",
      runId: "turn-1",
      item: expect.objectContaining({
        id: "item-cmd",
        type: "command_execution",
        command: "pnpm test",
      }),
    });
    expect((await iterator.next()).value).toEqual({
      type: "diff_updated",
      sessionId: "thread-1",
      runId: "turn-1",
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n",
      changedFiles: ["src/foo.ts"],
    });
    expect((await iterator.next()).value).toEqual({
      type: "item_started",
      sessionId: "thread-1",
      runId: "turn-1",
      item: expect.objectContaining({
        id: "item-commentary",
        type: "agent_message",
        messagePhase: "commentary",
      }),
    });
    expect((await iterator.next()).value).toEqual({
      type: "agent_delta",
      sessionId: "thread-1",
      runId: "turn-1",
      itemId: "item-commentary",
      messagePhase: "commentary",
      delta: "hello",
    });

    const approvalEvent = (await iterator.next()).value as Extract<AgentRunEvent, { type: "approval_requested" }>;
    expect(approvalEvent.approval.kind).toBe("command");
    expect(approvalEvent.approval.body).toContain("pnpm test");

    await driver.resolveApproval({
      kind: approvalEvent.approval.kind,
      requestId: approvalEvent.approval.requestId,
      approved: true,
      raw: approvalEvent.approval.raw,
    });

    expect((await iterator.next()).value).toEqual({
      type: "run_completed",
      sessionId: "thread-1",
      runId: "turn-1",
      status: "completed",
    });
    expect((await iterator.next()).done).toBe(true);
    await expect(driver.interruptRun({ sessionId: "thread-1", runId: "turn-1" })).resolves.toBeUndefined();
  });

  it("requires a configured binary path when starting", async () => {
    driver = new CodexAppServerDriver(testConfig(" "));

    await expect(driver.start()).rejects.toThrow("Missing agent.binaryPath");
  });
});

function testConfig(binaryPath: string): AppConfig {
  return {
    feishu: {
      appId: "app",
      appSecret: "secret",
      allowedUsers: [],
      allowedChats: [],
    },
    projects: [testProject()],
    agent: {
      type: "codex",
      binaryPath,
      defaultSandbox: "workspace-write",
      defaultApprovalPolicy: "on-request",
      model: "gpt-5",
    },
    storage: { sqlitePath: ":memory:" },
    bot: {
      approvalTtlMs: 60_000,
      eventDedupTtlMs: 60_000,
      debugPromptAcceptedFeedback: false,
    },
  };
}

function testProject() {
  return {
    key: "bot",
    name: "Bot",
    path: process.cwd(),
    sandbox: "workspace-write" as const,
    approvalPolicy: "on-request" as const,
  };
}

function createFakeAppServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-app-server-"));
  const file = join(dir, "codex-fake");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/plan/updated", params: {
      threadId: message.params.threadId,
      turnId: "turn-1",
      explanation: null,
      plan: [{ step: "Run tests", status: "inProgress" }]
    }});
    send({ method: "item/started", params: {
      threadId: message.params.threadId,
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "item-cmd",
        command: "pnpm test",
        cwd: message.params.cwd,
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    }});
    send({ method: "turn/diff/updated", params: {
      threadId: message.params.threadId,
      turnId: "turn-1",
      diff: "diff --git a/src/foo.ts b/src/foo.ts\\n"
    }});
    send({ method: "item/started", params: {
      threadId: message.params.threadId,
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-commentary",
        text: "",
        phase: "commentary",
        memoryCitation: null
      }
    }});
    send({ method: "item/agentMessage/delta", params: {
      threadId: message.params.threadId,
      turnId: "turn-1",
      itemId: "item-commentary",
      delta: "hello"
    }});
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {
      threadId: message.params.threadId,
      turnId: "turn-1",
      itemId: "item-2",
      command: "pnpm test",
      cwd: message.params.cwd,
      reason: "needs tests"
    }});
    return;
  }
  if (message.id === "approval-1") {
    if (message.result?.decision !== "accept") {
      send({ method: "error", params: { message: "unexpected approval decision" } });
      return;
    }
    send({ method: "turn/completed", params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    }});
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}
