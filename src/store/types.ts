import type { ApprovalKind } from "../codex/types.js";

export interface CurrentSession {
  userOpenId: string;
  projectKey: string;
  codexThreadId: string | null;
  activeTurnId: string | null;
  lastChatId: string | null;
  updatedAt: number;
}

export interface PendingApproval {
  approvalShortId: string;
  userOpenId: string;
  codexThreadId: string;
  turnId: string;
  requestId: string;
  approvalKind: ApprovalKind;
  payloadJson: string;
  expiresAt: number;
}

export interface StateStore {
  getCurrentSession(userOpenId: string): Promise<CurrentSession | null>;
  upsertCurrentSession(session: CurrentSession): Promise<void>;
  clearActiveTurn(userOpenId: string, turnId?: string): Promise<void>;
  markInterruptedActiveSessions(): Promise<CurrentSession[]>;
  savePendingApproval(approval: PendingApproval): Promise<void>;
  getPendingApproval(approvalShortId: string): Promise<PendingApproval | null>;
  deletePendingApproval(approvalShortId: string): Promise<void>;
  rememberEvent(eventId: string, expiresAt: number): Promise<boolean>;
  cleanupExpired(now: number): Promise<void>;
  close(): Promise<void>;
}
