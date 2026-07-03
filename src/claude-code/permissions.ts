import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AgentApprovalKind } from "../agent/types.js";
import type { ApprovalPolicy, SandboxMode } from "../config/types.js";

export function toClaudePermissionMode(policy: ApprovalPolicy): PermissionMode {
  switch (policy) {
    case "never":
      return "dontAsk";
    case "untrusted":
    case "on-failure":
    case "on-request":
      return "default";
  }
}

export function toClaudeSandbox(mode: SandboxMode): Options["sandbox"] {
  if (mode === "danger-full-access") return { enabled: false };
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: false,
  };
}

export function approvalKind(toolName: string): AgentApprovalKind {
  if (toolName === "Bash") return "command";
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) return "file_change";
  return "permissions";
}

export function formatToolRequestBody(toolName: string, input: Record<string, unknown>, description: string | undefined): string {
  const lines = [`Tool: ${toolName}`];
  if (description) lines.push("", description);
  if (toolName === "Bash" && typeof input.command === "string") lines.push("", `Command: ${input.command}`);
  else lines.push("", "Input:", "```json", JSON.stringify(input, null, 2), "```");
  return lines.join("\n");
}
