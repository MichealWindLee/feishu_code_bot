import type { CodexApprovalRequest } from "./types.js";

type JsonRpcId = string | number;

export type ApprovalRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

export function toApprovalRequest(message: ApprovalRpcMessage): CodexApprovalRequest | null {
  const params = message.params as Record<string, unknown> | undefined;
  if (!params) return null;
  const threadId = String(params.threadId ?? "");
  const turnId = String(params.turnId ?? "");
  const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
  const raw = { method: message.method, requestId: message.id, params };

  if (message.method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "(unknown command)";
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    return {
      kind: "command",
      requestId: message.id as JsonRpcId,
      threadId,
      turnId,
      itemId,
      title: "Codex wants to run a command",
      body: [`Command: ${command}`, cwd ? `CWD: ${cwd}` : null, params.reason ? `Reason: ${params.reason}` : null]
        .filter(Boolean)
        .join("\n"),
      raw,
    };
  }

  if (message.method === "item/fileChange/requestApproval") {
    return {
      kind: "file_change",
      requestId: message.id as JsonRpcId,
      threadId,
      turnId,
      itemId,
      title: "Codex wants extra file write access",
      body: String(params.reason ?? params.grantRoot ?? "File change approval requested."),
      raw,
    };
  }

  if (message.method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      requestId: message.id as JsonRpcId,
      threadId,
      turnId,
      itemId,
      title: "Codex requests additional permissions",
      body: [
        params.reason ? `Reason: ${params.reason}` : "Additional permissions requested.",
        `Permissions: ${JSON.stringify(params.permissions ?? {})}`,
      ].join("\n"),
      raw,
    };
  }

  if (message.method === "execCommandApproval") {
    const command = Array.isArray(params.command) ? params.command.map(String).join(" ") : "(unknown command)";
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    return {
      kind: "legacy_exec",
      requestId: message.id as JsonRpcId,
      threadId: String(params.conversationId ?? ""),
      turnId: String(params.callId ?? ""),
      itemId: typeof params.approvalId === "string" ? params.approvalId : undefined,
      title: "Codex wants to run a command",
      body: [`Command: ${command}`, cwd ? `CWD: ${cwd}` : null, params.reason ? `Reason: ${params.reason}` : null]
        .filter(Boolean)
        .join("\n"),
      raw,
    };
  }

  if (message.method === "applyPatchApproval") {
    return {
      kind: "legacy_apply_patch",
      requestId: message.id as JsonRpcId,
      threadId: String(params.conversationId ?? ""),
      turnId: String(params.callId ?? ""),
      title: "Codex wants to apply a patch",
      body: [
        params.reason ? `Reason: ${params.reason}` : "Patch approval requested.",
        params.grantRoot ? `Grant root: ${params.grantRoot}` : null,
        `Files: ${Object.keys((params.fileChanges as Record<string, unknown> | undefined) ?? {}).join(", ") || "(unknown)"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      raw,
    };
  }

  return null;
}

export function approvalResult(kind: string, approved: boolean, params: unknown): unknown {
  if (kind === "legacy_exec" || kind === "legacy_apply_patch") {
    return { decision: approved ? "approved" : "denied" };
  }
  if (kind === "permissions") {
    if (!approved) return { permissions: {}, scope: "turn" };
    const requested = (params as { permissions?: { network?: unknown; fileSystem?: unknown } } | undefined)
      ?.permissions;
    const permissions: Record<string, unknown> = {};
    if (requested?.network) permissions.network = requested.network;
    if (requested?.fileSystem) permissions.fileSystem = requested.fileSystem;
    return { permissions, scope: "session" };
  }
  return { decision: approved ? "accept" : "decline" };
}
