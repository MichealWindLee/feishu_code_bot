import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../src/store/sqlite-state-store.js";

describe("SqliteStateStore", () => {
  it("supports in-memory sqlite state for tests and local experiments", async () => {
    const store = new SqliteStateStore(":memory:");
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      agentSessionId: null,
      activeRunId: null,
      lastChatId: "chat-1",
      updatedAt: 1,
    });

    expect((await store.getCurrentSession("u1"))?.projectKey).toBe("bot");
    await store.close();
  });

  it("persists current sessions and clears interrupted active runs", async () => {
    const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), "feishu-code-bot-")), "state.sqlite"));
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      agentSessionId: "session-1",
      activeRunId: "run-1",
      lastChatId: "chat-1",
      updatedAt: 1,
    });

    expect((await store.getCurrentSession("u1"))?.activeRunId).toBe("run-1");
    const interrupted = await store.markInterruptedActiveSessions();
    expect(interrupted).toHaveLength(1);
    expect((await store.getCurrentSession("u1"))?.activeRunId).toBeNull();
    await store.close();
  });

  it("deduplicates events and expires approvals", async () => {
    const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), "feishu-code-bot-")), "state.sqlite"));
    expect(await store.rememberEvent("e1", Date.now() + 1000)).toBe(true);
    expect(await store.rememberEvent("e1", Date.now() + 1000)).toBe(false);

    await store.savePendingApproval({
      approvalShortId: "a1",
      userOpenId: "u1",
      agentSessionId: "session-1",
      runId: "run-1",
      requestId: "9",
      approvalKind: "command",
      payloadJson: "{}",
      expiresAt: 1,
    });
    await store.cleanupExpired(Date.now());
    expect(await store.getPendingApproval("a1")).toBeNull();
    await store.close();
  });

  it("deletes pending approvals by user", async () => {
    const store = new SqliteStateStore(":memory:");
    await store.savePendingApproval({
      approvalShortId: "a1",
      userOpenId: "u1",
      agentSessionId: "session-1",
      runId: "run-1",
      requestId: "9",
      approvalKind: "command",
      payloadJson: "{}",
      expiresAt: Date.now() + 1000,
    });
    await store.savePendingApproval({
      approvalShortId: "a2",
      userOpenId: "u2",
      agentSessionId: "session-2",
      runId: "run-2",
      requestId: "10",
      approvalKind: "command",
      payloadJson: "{}",
      expiresAt: Date.now() + 1000,
    });

    await store.deletePendingApprovalsForUser("u1");

    expect(await store.getPendingApproval("a1")).toBeNull();
    expect(await store.getPendingApproval("a2")).toBeTruthy();
    await store.close();
  });

  it("persists and expires pending user input requests", async () => {
    const store = new SqliteStateStore(":memory:");
    await store.savePendingUserInput({
      userInputShortId: "q1",
      userOpenId: "u1",
      agentSessionId: "session-1",
      runId: "run-1",
      requestId: "ask-1",
      payloadJson: "{}",
      responseJson: JSON.stringify({ answers: {} }),
      expiresAt: Date.now() + 1000,
    });

    await store.updatePendingUserInputResponse("q1", JSON.stringify({ answers: { Framework: "React" } }));
    expect((await store.getPendingUserInput("q1"))?.responseJson).toContain("React");

    await store.deletePendingUserInputsForUser("u1");
    expect(await store.getPendingUserInput("q1")).toBeNull();
    await store.close();
  });
});
