import type { AgentItemSummary, AgentMessagePhase, AgentPlanStep } from "../agent/types.js";

export function readPlanSteps(params: Record<string, unknown> | undefined): AgentPlanStep[] {
  const plan = Array.isArray(params?.plan) ? params.plan : [];
  return plan.map((step): AgentPlanStep => {
    const record = asRecord(step);
    return {
      step: stringOr(record?.step, "(unknown step)"),
      status: readPlanStepStatus(record?.status),
    };
  });
}

export function summarizeItem(item: unknown): AgentItemSummary {
  const record = asRecord(item);
  if (!record) return { id: "unknown", type: "other", title: "Codex activity" };

  const id = stringOr(record.id, "unknown");
  switch (record.type) {
    case "userMessage":
      return { id, type: "user_message", title: "User message" };
    case "agentMessage":
      return {
        id,
        type: "agent_message",
        title: "Agent response",
        text: typeof record.text === "string" ? record.text : undefined,
        messagePhase: readMessagePhase(record.phase),
      };
    case "reasoning":
      return { id, type: "reasoning", title: "Reasoning" };
    case "commandExecution":
      return {
        id,
        type: "command_execution",
        title: stringOr(record.command, "Command execution"),
        status: typeof record.status === "string" ? record.status : undefined,
        command: typeof record.command === "string" ? record.command : undefined,
        cwd: typeof record.cwd === "string" ? record.cwd : undefined,
        exitCode: typeof record.exitCode === "number" || record.exitCode === null ? record.exitCode : undefined,
        durationMs: typeof record.durationMs === "number" || record.durationMs === null ? record.durationMs : undefined,
      };
    case "fileChange":
      return {
        id,
        type: "file_change",
        title: "File changes",
        status: typeof record.status === "string" ? record.status : undefined,
        changedFiles: readChangedFiles(record.changes),
      };
    case "mcpToolCall":
      return {
        id,
        type: "mcp_tool_call",
        title: `MCP tool: ${stringOr(record.tool, "unknown")}`,
        status: typeof record.status === "string" ? record.status : undefined,
        toolName: [record.server, record.tool].filter((value) => typeof value === "string").join(".") || undefined,
        durationMs: typeof record.durationMs === "number" || record.durationMs === null ? record.durationMs : undefined,
      };
    case "dynamicToolCall":
      return {
        id,
        type: "dynamic_tool_call",
        title: `Tool: ${stringOr(record.tool, "unknown")}`,
        status: typeof record.status === "string" ? record.status : undefined,
        toolName: [record.namespace, record.tool].filter((value) => typeof value === "string").join(".") || undefined,
        durationMs: typeof record.durationMs === "number" || record.durationMs === null ? record.durationMs : undefined,
      };
    case "webSearch":
      return {
        id,
        type: "web_search",
        title: `Web search: ${stringOr(record.query, "unknown")}`,
      };
    case "imageGeneration":
      return {
        id,
        type: "image_generation",
        title: "Image generation",
        status: typeof record.status === "string" ? record.status : undefined,
      };
    default:
      return { id, type: "other", title: typeof record.type === "string" ? record.type : "Codex activity" };
  }
}

export function extractChangedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch?.[2]) files.add(diffMatch[2]);
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (newFileMatch?.[1]) files.add(newFileMatch[1]);
  }
  return [...files];
}

export function readErrorMessage(params: Record<string, unknown> | undefined): string {
  if (typeof params?.message === "string") return params.message;
  const error = asRecord(params?.error);
  if (typeof error?.message === "string") return error.message;
  return "Codex error";
}

export function readTurnId(params: Record<string, unknown> | undefined): string | undefined {
  const turn = params?.turn as { id?: string } | undefined;
  return turn?.id;
}

export function readTurnStatus(params: Record<string, unknown> | undefined): string {
  const turn = params?.turn as { status?: string } | undefined;
  return turn?.status ?? "completed";
}

function readPlanStepStatus(status: unknown): AgentPlanStep["status"] {
  return status === "pending" || status === "inProgress" || status === "completed" ? status : "pending";
}

function readMessagePhase(phase: unknown): AgentMessagePhase | null | undefined {
  if (phase === "commentary" || phase === "final_answer") return phase;
  if (phase === null) return null;
  return undefined;
}

function readChangedFiles(changes: unknown): string[] {
  if (!Array.isArray(changes)) return [];
  return [
    ...new Set(
      changes.map((change) => asRecord(change)?.path).filter((path): path is string => typeof path === "string"),
    ),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
