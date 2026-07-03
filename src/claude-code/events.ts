import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentItemSummary, AgentRunEvent } from "../agent/types.js";
import { readContentBlocks, stringifyContent, type ContentBlock } from "./content.js";
import { asRecord } from "./utils.js";

export class ClaudeCodeEventMapper {
  private readonly toolItems = new Map<string, AgentItemSummary>();
  private readonly toolItemRuns = new Map<string, string>();

  eventsFromMessage(sessionId: string, runId: string, message: SDKMessage): AgentRunEvent[] {
    if (message.type === "assistant") return this.eventsFromAssistantMessage(sessionId, runId, message);
    if (message.type === "user") return this.eventsFromUserMessage(sessionId, runId, message);
    if (message.type === "result") return eventsFromResultMessage(sessionId, runId, message);
    if (message.type === "system") return eventsFromSystemMessage(sessionId, runId, message);
    return [];
  }

  clear(): void {
    this.toolItems.clear();
    this.toolItemRuns.clear();
  }

  clearRun(runId: string): void {
    for (const [itemId, itemRunId] of this.toolItemRuns.entries()) {
      if (itemRunId === runId) {
        this.toolItemRuns.delete(itemId);
        this.toolItems.delete(itemId);
      }
    }
  }

  private eventsFromAssistantMessage(sessionId: string, runId: string, message: Extract<SDKMessage, { type: "assistant" }>): AgentRunEvent[] {
    const events: AgentRunEvent[] = [];
    for (const block of readContentBlocks(message.message.content)) {
      if (block.type !== "tool_use") continue;
      const item = summarizeToolUse(block);
      this.toolItems.set(item.id, item);
      this.toolItemRuns.set(item.id, runId);
      events.push({
        type: "item_started",
        sessionId,
        runId,
        item,
      });
    }
    return events;
  }

  private eventsFromUserMessage(sessionId: string, runId: string, message: Extract<SDKMessage, { type: "user" }>): AgentRunEvent[] {
    const events: AgentRunEvent[] = [];
    for (const block of readContentBlocks(message.message.content)) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const startedItem = this.toolItems.get(block.tool_use_id);
      this.toolItems.delete(block.tool_use_id);
      this.toolItemRuns.delete(block.tool_use_id);
      events.push({
        type: "item_completed",
        sessionId,
        runId,
        item: startedItem
          ? {
            ...startedItem,
            status: block.is_error ? "failed" : "completed",
            text: stringifyContent(block.content),
          }
          : {
            id: block.tool_use_id,
            type: "other",
            title: "Tool result",
            status: block.is_error ? "failed" : "completed",
            text: stringifyContent(block.content),
          },
      });
    }
    return events;
  }
}

function eventsFromResultMessage(sessionId: string, runId: string, message: Extract<SDKMessage, { type: "result" }>): AgentRunEvent[] {
  if (message.subtype === "success") {
    const events: AgentRunEvent[] = [];
    if (message.result) {
      events.push({
        type: "agent_delta",
        sessionId,
        runId,
        delta: message.result,
        messagePhase: "final_answer",
      });
    }
    events.push({ type: "run_completed", sessionId, runId, status: message.is_error ? "failed" : "completed" });
    return events;
  }
  return [
    {
      type: "error",
      sessionId,
      runId,
      message: message.errors?.join("\n") || `Claude Code failed: ${message.subtype}`,
    },
    { type: "run_completed", sessionId, runId, status: "failed" },
  ];
}

function eventsFromSystemMessage(sessionId: string, runId: string, message: Extract<SDKMessage, { type: "system" }>): AgentRunEvent[] {
  if (message.subtype === "task_started") {
    return [
      {
        type: "item_started",
        sessionId,
        runId,
        item: {
          id: message.task_id,
          type: "dynamic_tool_call",
          title: message.description,
          status: "inProgress",
          toolName: message.task_type ?? message.subagent_type ?? "task",
        },
      },
    ];
  }
  if (message.subtype === "task_notification") {
    return [
      {
        type: "item_completed",
        sessionId,
        runId,
        item: {
          id: message.task_id,
          type: "dynamic_tool_call",
          title: message.summary,
          status: message.status,
          toolName: "task",
          text: message.summary,
        },
      },
    ];
  }
  if (message.subtype === "permission_denied") {
    return [
      {
        type: "warning",
        sessionId,
        message: message.message,
      },
    ];
  }
  return [];
}

function summarizeToolUse(block: ContentBlock): AgentItemSummary {
  const input = asRecord(block.input);
  if (block.name === "Bash") {
    return {
      id: block.id ?? randomUUID(),
      type: "command_execution",
      title: typeof input.command === "string" ? input.command : "Bash command",
      status: "inProgress",
      command: typeof input.command === "string" ? input.command : undefined,
    };
  }
  return {
    id: block.id ?? randomUUID(),
    type: block.name?.startsWith("mcp__") ? "mcp_tool_call" : "dynamic_tool_call",
    title: block.name ?? "Tool call",
    status: "inProgress",
    toolName: block.name,
  };
}
