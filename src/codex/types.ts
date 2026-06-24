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

export type CodexPlanStepStatus = "pending" | "inProgress" | "completed";

export interface CodexPlanStep {
  step: string;
  status: CodexPlanStepStatus;
}

export type CodexItemType =
  | "agent_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "web_search"
  | "image_generation"
  | "user_message"
  | "other";

export interface CodexItemSummary {
  id: string;
  type: CodexItemType;
  title: string;
  status?: string;
  text?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  changedFiles?: string[];
  toolName?: string;
}

export type CodexEvent =
  | { type: "turn_started"; threadId: string; turnId: string }
  | { type: "agent_delta"; threadId: string; turnId: string; delta: string }
  | { type: "plan_updated"; threadId: string; turnId: string; explanation?: string | null; steps: CodexPlanStep[] }
  | { type: "item_started"; threadId: string; turnId: string; item: CodexItemSummary }
  | { type: "item_completed"; threadId: string; turnId: string; item: CodexItemSummary }
  | { type: "diff_updated"; threadId: string; turnId: string; diff: string; changedFiles: string[] }
  | { type: "approval_requested"; approval: CodexApprovalRequest }
  | { type: "turn_completed"; threadId: string; turnId: string; status: string }
  | { type: "warning"; threadId?: string; message: string }
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
