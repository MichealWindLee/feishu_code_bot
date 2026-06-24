import type { ProjectConfig } from "../config/types.js";

export interface CodexThread {
  id: string;
}

export interface StartThreadInput {
  project: ProjectConfig;
  model?: string;
}

export interface ResumeThreadInput extends StartThreadInput {
  threadId: string;
}

export interface StartTurnInput {
  threadId: string;
  project: ProjectConfig;
  text: string;
  clientUserMessageId?: string;
}

export interface InterruptTurnInput {
  threadId: string;
  turnId: string;
}

export type ApprovalKind = "command" | "file_change" | "permissions" | "legacy_exec" | "legacy_apply_patch";

export interface CodexApprovalRequest {
  kind: ApprovalKind;
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId?: string;
  title: string;
  body: string;
  raw: unknown;
}

export type CodexEvent =
  | { type: "turn_started"; threadId: string; turnId: string }
  | { type: "agent_delta"; threadId: string; turnId: string; delta: string }
  | { type: "approval_requested"; approval: CodexApprovalRequest }
  | { type: "turn_completed"; threadId: string; turnId: string; status: string }
  | { type: "error"; threadId?: string; turnId?: string; message: string };

export interface ResolveApprovalInput {
  kind: ApprovalKind;
  requestId: string | number;
  approved: boolean;
  raw: unknown;
}

export interface CodexDriver {
  start(): Promise<void>;
  stop(): Promise<void>;
  startThread(input: StartThreadInput): Promise<CodexThread>;
  resumeThread(threadId: string, input: ResumeThreadInput): Promise<CodexThread>;
  startTurn(input: StartTurnInput): AsyncIterable<CodexEvent>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  resolveApproval(input: ResolveApprovalInput): Promise<void>;
}
