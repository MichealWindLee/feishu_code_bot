import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { CurrentSession, PendingApproval, PendingUserInput, StateStore } from "./types.js";

type SessionRow = {
  user_open_id: string;
  project_key: string;
  agent_session_id: string | null;
  active_run_id: string | null;
  last_chat_id: string | null;
  updated_at: number;
};

type ApprovalRow = {
  approval_short_id: string;
  user_open_id: string;
  agent_session_id: string;
  run_id: string;
  request_id: string;
  approval_kind: string;
  payload_json: string;
  expires_at: number;
};

type UserInputRow = {
  user_input_short_id: string;
  user_open_id: string;
  agent_session_id: string;
  run_id: string;
  request_id: string;
  payload_json: string;
  response_json: string;
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
          user_open_id, project_key, agent_session_id, active_run_id, last_chat_id, updated_at
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(user_open_id) do update set
          project_key = excluded.project_key,
          agent_session_id = excluded.agent_session_id,
          active_run_id = excluded.active_run_id,
          last_chat_id = excluded.last_chat_id,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        session.userOpenId,
        session.projectKey,
        session.agentSessionId,
        session.activeRunId,
        session.lastChatId,
        session.updatedAt,
      );
  }

  async clearActiveRun(userOpenId: string, runId?: string): Promise<void> {
    if (runId) {
      this.db
        .prepare(
          `
          update current_sessions
          set active_run_id = null, updated_at = ?
          where user_open_id = ? and active_run_id = ?
        `,
        )
        .run(Date.now(), userOpenId, runId);
      return;
    }
    this.db
      .prepare(
        `
        update current_sessions
        set active_run_id = null, updated_at = ?
        where user_open_id = ?
      `,
      )
      .run(Date.now(), userOpenId);
  }

  async markInterruptedActiveSessions(): Promise<CurrentSession[]> {
    const rows = this.db
      .prepare("select * from current_sessions where active_run_id is not null")
      .all() as SessionRow[];
    this.db
      .prepare("update current_sessions set active_run_id = null, updated_at = ? where active_run_id is not null")
      .run(Date.now());
    return rows.map(mapSession);
  }

  async savePendingApproval(approval: PendingApproval): Promise<void> {
    this.db
      .prepare(
        `
        insert into pending_approvals (
          approval_short_id, user_open_id, agent_session_id, run_id, request_id,
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
        approval.agentSessionId,
        approval.runId,
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

  async savePendingUserInput(input: PendingUserInput): Promise<void> {
    this.db
      .prepare(
        `
        insert into pending_user_inputs (
          user_input_short_id, user_open_id, agent_session_id, run_id, request_id,
          payload_json, response_json, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(user_input_short_id) do update set
          payload_json = excluded.payload_json,
          response_json = excluded.response_json,
          expires_at = excluded.expires_at
      `,
      )
      .run(
        input.userInputShortId,
        input.userOpenId,
        input.agentSessionId,
        input.runId,
        input.requestId,
        input.payloadJson,
        input.responseJson,
        input.expiresAt,
      );
  }

  async getPendingUserInput(userInputShortId: string): Promise<PendingUserInput | null> {
    const row = this.db
      .prepare("select * from pending_user_inputs where user_input_short_id = ?")
      .get(userInputShortId) as UserInputRow | undefined;
    return row ? mapUserInput(row) : null;
  }

  async updatePendingUserInputResponse(userInputShortId: string, responseJson: string): Promise<void> {
    this.db
      .prepare("update pending_user_inputs set response_json = ? where user_input_short_id = ?")
      .run(responseJson, userInputShortId);
  }

  async deletePendingUserInput(userInputShortId: string): Promise<void> {
    this.db.prepare("delete from pending_user_inputs where user_input_short_id = ?").run(userInputShortId);
  }

  async deletePendingUserInputsForUser(userOpenId: string): Promise<void> {
    this.db.prepare("delete from pending_user_inputs where user_open_id = ?").run(userOpenId);
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
    this.db.prepare("delete from pending_user_inputs where expires_at <= ?").run(now);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private migrate(): void {
    this.dropOldCodexStateIfNeeded();
    this.db.exec(`
      create table if not exists current_sessions (
        user_open_id text primary key,
        project_key text not null,
        agent_session_id text,
        active_run_id text,
        last_chat_id text,
        updated_at integer not null
      );

      create table if not exists pending_approvals (
        approval_short_id text primary key,
        user_open_id text not null,
        agent_session_id text not null,
        run_id text not null,
        request_id text not null,
        approval_kind text not null,
        payload_json text not null,
        expires_at integer not null
      );

      create table if not exists pending_user_inputs (
        user_input_short_id text primary key,
        user_open_id text not null,
        agent_session_id text not null,
        run_id text not null,
        request_id text not null,
        payload_json text not null,
        response_json text not null,
        expires_at integer not null
      );

      create table if not exists event_dedup (
        event_id text primary key,
        expires_at integer not null
      );

      create index if not exists idx_pending_approvals_expires_at
        on pending_approvals (expires_at);
      create index if not exists idx_pending_user_inputs_expires_at
        on pending_user_inputs (expires_at);
      create index if not exists idx_event_dedup_expires_at
        on event_dedup (expires_at);
    `);
  }

  private dropOldCodexStateIfNeeded(): void {
    const sessionColumns = tableColumns(this.db, "current_sessions");
    const approvalColumns = tableColumns(this.db, "pending_approvals");
    if (sessionColumns.size > 0 && !sessionColumns.has("agent_session_id")) {
      this.db.exec("drop table if exists current_sessions;");
    }
    if (approvalColumns.size > 0 && !approvalColumns.has("agent_session_id")) {
      this.db.exec("drop table if exists pending_approvals;");
    }
  }
}

function mapSession(row: SessionRow): CurrentSession {
  return {
    userOpenId: row.user_open_id,
    projectKey: row.project_key,
    agentSessionId: row.agent_session_id,
    activeRunId: row.active_run_id,
    lastChatId: row.last_chat_id,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: ApprovalRow): PendingApproval {
  return {
    approvalShortId: row.approval_short_id,
    userOpenId: row.user_open_id,
    agentSessionId: row.agent_session_id,
    runId: row.run_id,
    requestId: row.request_id,
    approvalKind: row.approval_kind as PendingApproval["approvalKind"],
    payloadJson: row.payload_json,
    expiresAt: row.expires_at,
  };
}

function mapUserInput(row: UserInputRow): PendingUserInput {
  return {
    userInputShortId: row.user_input_short_id,
    userOpenId: row.user_open_id,
    agentSessionId: row.agent_session_id,
    runId: row.run_id,
    requestId: row.request_id,
    payloadJson: row.payload_json,
    responseJson: row.response_json,
    expiresAt: row.expires_at,
  };
}

function tableColumns(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
}
