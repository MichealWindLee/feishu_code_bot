import type { AgentApprovalKind } from "../agent/types.js";

export interface CurrentSession {
  userOpenId: string;
  projectKey: string;
  agentSessionId: string | null;
  activeRunId: string | null;
  lastChatId: string | null;
  updatedAt: number;
}

export interface PendingApproval {
  approvalShortId: string;
  userOpenId: string;
  agentSessionId: string;
  runId: string;
  requestId: string;
  approvalKind: AgentApprovalKind;
  payloadJson: string;
  expiresAt: number;
}

export interface PendingUserInput {
  userInputShortId: string;
  userOpenId: string;
  agentSessionId: string;
  runId: string;
  requestId: string;
  payloadJson: string;
  responseJson: string;
  expiresAt: number;
}

export interface StateStore {
  getCurrentSession(userOpenId: string): Promise<CurrentSession | null>;
  upsertCurrentSession(session: CurrentSession): Promise<void>;
  clearActiveRun(userOpenId: string, runId?: string): Promise<void>;
  markInterruptedActiveSessions(): Promise<CurrentSession[]>;
  savePendingApproval(approval: PendingApproval): Promise<void>;
  getPendingApproval(approvalShortId: string): Promise<PendingApproval | null>;
  deletePendingApproval(approvalShortId: string): Promise<void>;
  deletePendingApprovalsForUser(userOpenId: string): Promise<void>;
  savePendingUserInput(input: PendingUserInput): Promise<void>;
  getPendingUserInput(userInputShortId: string): Promise<PendingUserInput | null>;
  updatePendingUserInputResponse(userInputShortId: string, responseJson: string): Promise<void>;
  deletePendingUserInput(userInputShortId: string): Promise<void>;
  deletePendingUserInputsForUser(userOpenId: string): Promise<void>;
  rememberEvent(eventId: string, expiresAt: number): Promise<boolean>;
  cleanupExpired(now: number): Promise<void>;
  close(): Promise<void>;
}
