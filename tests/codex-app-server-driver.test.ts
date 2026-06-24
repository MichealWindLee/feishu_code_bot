import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerDriver } from "../src/codex/app-server-driver.js";
import type { CodexEvent } from "../src/codex/types.js";
import type { AppConfig } from "../src/config/types.js";

describe("CodexAppServerDriver", () => {
  let driver: CodexAppServerDriver | null = null;

  afterEach(async () => {
    await driver?.stop();
    driver = null;
  });

  it("speaks the app-server JSON-RPC subset and resolves approvals", async () => {
    const binaryPath = createFakeAppServer();
    driver = new CodexAppServerDriver(testConfig(binaryPath));

    await driver.start();
    const thread = await driver.startThread({ project: testProject() });
    expect(thread.id).toBe("thread-1");
    await expect(driver.resumeThread("thread-1", { threadId: "thread-1", project: testProject() })).resolves.toEqual({
      id: "thread-1",
    });

    const iterator = driver
      .startTurn({
        threadId: "thread-1",
        project: testProject(),
        text: "please test",
        clientUserMessageId: "message-1",
      })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({
      type: "turn_started",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect((await iterator.next()).value).toEqual({
      type: "agent_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      delta: "hello",
    });

    const approvalEvent = (await iterator.next()).value as Extract<CodexEvent, { type: "approval_requested" }>;
    expect(approvalEvent.approval.kind).toBe("command");
    expect(approvalEvent.approval.body).toContain("pnpm test");

    await driver.resolveApproval({
      kind: approvalEvent.approval.kind,
      requestId: approvalEvent.approval.requestId,
      approved: true,
      raw: approvalEvent.approval.raw,
    });

    expect((await iterator.next()).value).toEqual({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    expect((await iterator.next()).done).toBe(true);
    await expect(driver.interruptTurn({ threadId: "thread-1", turnId: "turn-1" })).resolves.toBeUndefined();
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
    codex: {
      binaryPath,
      defaultSandbox: "workspace-write",
      defaultApprovalPolicy: "on-request",
      model: "gpt-5",
    },
    storage: { sqlitePath: ":memory:" },
    bot: {
      approvalTtlMs: 60_000,
      eventDedupTtlMs: 60_000,
      streamFlushMs: 1,
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
    send({ method: "item/agentMessage/delta", params: {
      threadId: message.params.threadId,
      turnId: "turn-1",
      itemId: "item-1",
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
