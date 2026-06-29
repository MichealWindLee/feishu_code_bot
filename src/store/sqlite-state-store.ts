import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { CurrentSession, PendingApproval, StateStore } from "./types.js";

type SessionRow = {
  user_open_id: string;
  project_key: string;
  codex_thread_id: string | null;
  active_turn_id: string | null;
  last_chat_id: string | null;
  updated_at: number;
};

type ApprovalRow = {
  approval_short_id: string;
  user_open_id: string;
  codex_thread_id: string;
  turn_id: string;
  request_id: string;
  approval_kind: string;
  payload_json: string;
  expires_at: number;
};

export class SqliteStateStore implements StateStore {
  private db: Database.Database;

  constructor(sqlitePath: string) {
    if (sqlitePath === ":memory:") {
      this.db = new Database(sqlitePath);
    } else {
      const absolutePath = resolve(sqlitePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      this.db = new Database(absolutePath);
      this.db.pragma("journal_mode = WAL");
    }
    this.migrate();
  }

  async getCurrentSession(userOpenId: string): Promise<CurrentSession | null> {
    const row = this.db
      .prepare("select * from current_sessions where user_open_id = ?")
      .get(userOpenId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  async upsertCurrentSession(session: CurrentSession): Promise<void> {
    this.db
      .prepare(
        `
        insert into current_sessions (
          user_open_id, project_key, codex_thread_id, active_turn_id, last_chat_id, updated_at
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(user_open_id) do update set
          project_key = excluded.project_key,
          codex_thread_id = excluded.codex_thread_id,
          active_turn_id = excluded.active_turn_id,
          last_chat_id = excluded.last_chat_id,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        session.userOpenId,
        session.projectKey,
        session.codexThreadId,
        session.activeTurnId,
        session.lastChatId,
        session.updatedAt,
      );
  }

  async clearActiveTurn(userOpenId: string, turnId?: string): Promise<void> {
    if (turnId) {
      this.db
        .prepare(
          `
          update current_sessions
          set active_turn_id = null, updated_at = ?
          where user_open_id = ? and active_turn_id = ?
        `,
        )
        .run(Date.now(), userOpenId, turnId);
      return;
    }
    this.db
      .prepare(
        `
        update current_sessions
        set active_turn_id = null, updated_at = ?
        where user_open_id = ?
      `,
      )
      .run(Date.now(), userOpenId);
  }

  async markInterruptedActiveSessions(): Promise<CurrentSession[]> {
    const rows = this.db
      .prepare("select * from current_sessions where active_turn_id is not null")
      .all() as SessionRow[];
    this.db
      .prepare("update current_sessions set active_turn_id = null, updated_at = ? where active_turn_id is not null")
      .run(Date.now());
    return rows.map(mapSession);
  }

  async savePendingApproval(approval: PendingApproval): Promise<void> {
    this.db
      .prepare(
        `
        insert into pending_approvals (
          approval_short_id, user_open_id, codex_thread_id, turn_id, request_id,
          approval_kind, payload_json, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(approval_short_id) do update set
          payload_json = excluded.payload_json,
          expires_at = excluded.expires_at
      `,
      )
      .run(
        approval.approvalShortId,
        approval.userOpenId,
        approval.codexThreadId,
        approval.turnId,
        approval.requestId,
        approval.approvalKind,
        approval.payloadJson,
        approval.expiresAt,
      );
  }

  async getPendingApproval(approvalShortId: string): Promise<PendingApproval | null> {
    const row = this.db
      .prepare("select * from pending_approvals where approval_short_id = ?")
      .get(approvalShortId) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  async deletePendingApproval(approvalShortId: string): Promise<void> {
    this.db.prepare("delete from pending_approvals where approval_short_id = ?").run(approvalShortId);
  }

  async deletePendingApprovalsForUser(userOpenId: string): Promise<void> {
    this.db.prepare("delete from pending_approvals where user_open_id = ?").run(userOpenId);
  }

  async rememberEvent(eventId: string, expiresAt: number): Promise<boolean> {
    try {
      this.db
        .prepare("insert into event_dedup (event_id, expires_at) values (?, ?)")
        .run(eventId, expiresAt);
      return true;
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return false;
      throw error;
    }
  }

  async cleanupExpired(now: number): Promise<void> {
    this.db.prepare("delete from event_dedup where expires_at <= ?").run(now);
    this.db.prepare("delete from pending_approvals where expires_at <= ?").run(now);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists current_sessions (
        user_open_id text primary key,
        project_key text not null,
        codex_thread_id text,
        active_turn_id text,
        last_chat_id text,
        updated_at integer not null
      );

      create table if not exists pending_approvals (
        approval_short_id text primary key,
        user_open_id text not null,
        codex_thread_id text not null,
        turn_id text not null,
        request_id text not null,
        approval_kind text not null,
        payload_json text not null,
        expires_at integer not null
      );

      create table if not exists event_dedup (
        event_id text primary key,
        expires_at integer not null
      );

      create index if not exists idx_pending_approvals_expires_at
        on pending_approvals (expires_at);
      create index if not exists idx_event_dedup_expires_at
        on event_dedup (expires_at);
    `);
  }
}

function mapSession(row: SessionRow): CurrentSession {
  return {
    userOpenId: row.user_open_id,
    projectKey: row.project_key,
    codexThreadId: row.codex_thread_id,
    activeTurnId: row.active_turn_id,
    lastChatId: row.last_chat_id,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: ApprovalRow): PendingApproval {
  return {
    approvalShortId: row.approval_short_id,
    userOpenId: row.user_open_id,
    codexThreadId: row.codex_thread_id,
    turnId: row.turn_id,
    requestId: row.request_id,
    approvalKind: row.approval_kind as PendingApproval["approvalKind"],
    payloadJson: row.payload_json,
    expiresAt: row.expires_at,
  };
}
