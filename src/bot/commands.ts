export type BotCommand =
  | { type: "help" }
  | { type: "projects" }
  | { type: "use"; projectKey: string }
  | { type: "new" }
  | { type: "end" }
  | { type: "status" }
  | { type: "stop" }
  | { type: "permissions" }
  | { type: "approve"; approvalId: string }
  | { type: "deny"; approvalId: string };

export function parseCommand(input: string): BotCommand | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;

  const [commandWithSlash, ...rest] = text.split(/\s+/);
  const command = commandWithSlash.slice(1).toLowerCase();
  const arg = rest[0];

  switch (command) {
    case "help":
      return { type: "help" };
    case "projects":
      return { type: "projects" };
    case "use":
      return arg ? { type: "use", projectKey: arg } : null;
    case "new":
      return { type: "new" };
    case "end":
    case "close":
    case "exit":
      return { type: "end" };
    case "status":
      return { type: "status" };
    case "stop":
      return { type: "stop" };
    case "permissions":
      return { type: "permissions" };
    case "approve":
      return arg ? { type: "approve", approvalId: arg } : null;
    case "deny":
      return arg ? { type: "deny", approvalId: arg } : null;
    default:
      return null;
  }
}

export function commandHelp(): string {
  return [
    "Feishu Codex Bot commands:",
    "- /projects: list configured projects",
    "- /use <project>: switch your current project",
    "- /new: start a fresh Codex session",
    "- /end: end your current Codex session",
    "- /status: show current session status",
    "- /stop: interrupt the active Codex turn",
    "- /permissions: show current Codex permission policy",
    "- /approve <id>: approve a pending Codex request",
    "- /deny <id>: deny a pending Codex request",
  ].join("\n");
}
