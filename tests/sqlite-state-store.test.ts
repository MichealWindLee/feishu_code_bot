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
      codexThreadId: null,
      activeTurnId: null,
      lastChatId: "chat-1",
      updatedAt: 1,
    });

    expect((await store.getCurrentSession("u1"))?.projectKey).toBe("bot");
    await store.close();
  });

  it("persists current sessions and clears interrupted active turns", async () => {
    const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), "feishu-code-bot-")), "state.sqlite"));
    await store.upsertCurrentSession({
      userOpenId: "u1",
      projectKey: "bot",
      codexThreadId: "thread-1",
      activeTurnId: "turn-1",
      lastChatId: "chat-1",
      updatedAt: 1,
    });

    expect((await store.getCurrentSession("u1"))?.activeTurnId).toBe("turn-1");
    const interrupted = await store.markInterruptedActiveSessions();
    expect(interrupted).toHaveLength(1);
    expect((await store.getCurrentSession("u1"))?.activeTurnId).toBeNull();
    await store.close();
  });

  it("deduplicates events and expires approvals", async () => {
    const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), "feishu-code-bot-")), "state.sqlite"));
    expect(await store.rememberEvent("e1", Date.now() + 1000)).toBe(true);
    expect(await store.rememberEvent("e1", Date.now() + 1000)).toBe(false);

    await store.savePendingApproval({
      approvalShortId: "a1",
      userOpenId: "u1",
      codexThreadId: "thread-1",
      turnId: "turn-1",
      requestId: "9",
      approvalKind: "command",
      payloadJson: "{}",
      expiresAt: 1,
    });
    await store.cleanupExpired(Date.now());
    expect(await store.getPendingApproval("a1")).toBeNull();
    await store.close();
  });
});
