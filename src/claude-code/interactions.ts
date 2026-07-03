import {
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type PermissionResult,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentApprovalRequest,
  AgentRunEvent,
  AgentUserInputRequest,
  AgentUserInputResponse,
  ResolveAgentApprovalInput,
  ResolveAgentUserInputInput,
  StartAgentRunInput,
} from "../agent/types.js";
import { AsyncQueue } from "../shared/async-queue.js";
import { approvalKind, formatToolRequestBody } from "./permissions.js";
import { readQuestions } from "./user-input.js";
import { asRecord } from "./utils.js";

type PendingApproval = {
  runId: string;
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
};

type PendingUserInput = {
  runId: string;
  resolve: (response: AgentUserInputResponse) => void;
  reject: (error: Error) => void;
};

export class ClaudeCodeInteractions {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();

  constructor(private readonly displayName: string) {}

  canUseTool(input: StartAgentRunInput, runId: string, queue: AsyncQueue<AgentRunEvent>): CanUseTool {
    return async (toolName, toolInput, options): Promise<PermissionResult> => {
      if (toolName === "AskUserQuestion") {
        const response = await this.requestUserInput({
          input,
          runId,
          queue,
          requestId: `${runId}:${options.toolUseID}`,
          toolInput,
        });
        return {
          behavior: "allow",
          updatedInput: { ...toolInput, answers: response.answers },
          toolUseID: options.toolUseID,
        };
      }

      const requestId = `${runId}:${options.toolUseID}`;
      const approved = await this.requestApproval({
        input,
        runId,
        queue,
        requestId,
        toolName,
        toolInput,
        title: options.title ?? `${this.displayName} wants to use ${toolName}`,
        description: options.description,
      });
      if (!approved) {
        return {
          behavior: "deny",
          message: "Denied by Feishu user.",
          toolUseID: options.toolUseID,
        };
      }
      return {
        behavior: "allow",
        toolUseID: options.toolUseID,
      };
    };
  }

  askUserQuestionHook(input: StartAgentRunInput, runId: string, queue: AsyncQueue<AgentRunEvent>): HookCallback {
    return async (hookInput, toolUseID): Promise<HookJSONOutput> => {
      const preToolUse = hookInput as PreToolUseHookInput;
      const requestId = `${runId}:${toolUseID ?? preToolUse.tool_use_id}`;
      const response = await this.requestUserInput({
        input,
        runId,
        queue,
        requestId,
        toolInput: asRecord(preToolUse.tool_input),
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...asRecord(preToolUse.tool_input), answers: response.answers },
        },
      };
    };
  }

  async resolveApproval(input: ResolveAgentApprovalInput): Promise<void> {
    const pending = this.pendingApprovals.get(String(input.requestId));
    if (!pending) throw new Error(`No pending Claude Code approval for ${String(input.requestId)}`);
    this.pendingApprovals.delete(String(input.requestId));
    pending.resolve(input.approved);
  }

  async resolveUserInput(input: ResolveAgentUserInputInput): Promise<void> {
    const pending = this.pendingUserInputs.get(String(input.requestId));
    if (!pending) throw new Error(`No pending Claude Code user input for ${String(input.requestId)}`);
    this.pendingUserInputs.delete(String(input.requestId));
    pending.resolve(input.response);
  }

  rejectPending(error: Error): void {
    for (const pending of this.pendingApprovals.values()) pending.reject(error);
    for (const pending of this.pendingUserInputs.values()) pending.reject(error);
    this.pendingApprovals.clear();
    this.pendingUserInputs.clear();
  }

  rejectPendingForRun(runId: string, error: Error): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      if (pending.runId === runId) {
        this.pendingApprovals.delete(requestId);
        pending.reject(error);
      }
    }
    for (const [requestId, pending] of this.pendingUserInputs.entries()) {
      if (pending.runId === runId) {
        this.pendingUserInputs.delete(requestId);
        pending.reject(error);
      }
    }
  }

  private requestApproval(args: {
    input: StartAgentRunInput;
    runId: string;
    queue: AsyncQueue<AgentRunEvent>;
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    title: string;
    description?: string;
  }): Promise<boolean> {
    const approval: AgentApprovalRequest = {
      kind: approvalKind(args.toolName),
      requestId: args.requestId,
      sessionId: args.input.sessionId,
      runId: args.runId,
      title: args.title,
      body: formatToolRequestBody(args.toolName, args.toolInput, args.description),
      raw: {
        requestId: args.requestId,
        toolName: args.toolName,
        input: args.toolInput,
      },
    };

    args.queue.push({ type: "approval_requested", approval });
    return new Promise<boolean>((resolve, reject) => {
      this.pendingApprovals.set(args.requestId, { runId: args.runId, resolve, reject });
    });
  }

  private requestUserInput(args: {
    input: StartAgentRunInput;
    runId: string;
    queue: AsyncQueue<AgentRunEvent>;
    requestId: string;
    toolInput: Record<string, unknown>;
  }): Promise<AgentUserInputResponse> {
    const questions = readQuestions(args.toolInput);
    const request: AgentUserInputRequest = {
      requestId: args.requestId,
      sessionId: args.input.sessionId,
      runId: args.runId,
      title: `${this.displayName} 需要你的反馈`,
      body: "请选择或补充信息，Agent 会根据你的反馈继续处理。",
      questions,
      raw: {
        requestId: args.requestId,
        toolName: "AskUserQuestion",
        input: args.toolInput,
      },
    };

    args.queue.push({ type: "user_input_requested", request });
    return new Promise<AgentUserInputResponse>((resolve, reject) => {
      this.pendingUserInputs.set(args.requestId, { runId: args.runId, resolve, reject });
    });
  }
}
