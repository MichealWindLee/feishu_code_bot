import { commandHelp, parseCommand, type BotCommand } from "./commands.js";
import { getProject } from "../config/index.js";
import type { CodeAgentDriver } from "../agent/types.js";
import type { AppConfig } from "../config/types.js";
import type { FeishuMessagePort, ReplyTarget } from "../feishu/types.js";
import type { SessionManager, SessionStatus } from "../session/session-manager.js";
import type { StateStore } from "../store/types.js";

type BotCommandHandlerDeps = {
  config: AppConfig;
  messages: FeishuMessagePort;
  agent: CodeAgentDriver;
  store: StateStore;
  sessions: SessionManager;
};

export class BotCommandHandler {
  constructor(private readonly deps: BotCommandHandlerDeps) {}

  async handle(command: BotCommand, userOpenId: string, target: ReplyTarget): Promise<void> {
    switch (command.type) {
      case "help":
        await this.deps.messages.sendMarkdown(target, commandHelp(this.deps.agent.metadata.displayName));
        return;
      case "projects":
        await this.deps.messages.sendMarkdown(target, this.formatProjects());
        return;
      case "use":
        await this.handleUseProject(command.projectKey, userOpenId, target);
        return;
      case "new":
        await this.handleNewSession(userOpenId, target);
        return;
      case "end":
        await this.handleEndSession(userOpenId, target);
        return;
      case "status":
        await this.handleStatus(userOpenId, target);
        return;
      case "stop":
        await this.handleStop(userOpenId, target);
        return;
      case "permissions":
        await this.handlePermissions(userOpenId, target);
        return;
      case "approve":
        await this.handleApproval(command.approvalId, true, userOpenId, target);
        return;
      case "deny":
        await this.handleApproval(command.approvalId, false, userOpenId, target);
        return;
      default:
        await this.deps.messages.sendMarkdown(target, "Unsupported command.");
    }
  }

  private async handleUseProject(projectKey: string, userOpenId: string, target: ReplyTarget): Promise<void> {
    const result = await this.deps.sessions.switchProject(userOpenId, target.chatId, projectKey);
    if (result.status === "unknown_project") {
      await this.deps.messages.sendMarkdown(target, `Unknown project: ${projectKey}\n\n${this.formatProjects()}`);
      return;
    }
    if (result.status === "busy") {
      await this.deps.messages.sendMarkdown(target, "A task is running. Use /stop before switching projects.");
      return;
    }
    await this.deps.messages.sendMarkdown(target, `Switched to project ${result.projectKey}: ${result.projectName}`);
  }

  private async handleNewSession(userOpenId: string, target: ReplyTarget): Promise<void> {
    const result = await this.deps.sessions.startNewSession(userOpenId, target.chatId);
    if (result.status === "missing_project") throw new Error(`Configured project missing: ${result.projectKey}`);
    await this.deps.messages.sendMarkdown(target, `Started a new ${this.deps.agent.metadata.displayName} session for ${result.projectKey}.`);
  }

  private async handleEndSession(userOpenId: string, target: ReplyTarget): Promise<void> {
    const result = await this.deps.sessions.endSession(userOpenId, target.chatId);
    if (result.status === "none") {
      await this.deps.messages.sendMarkdown(target, `No ${this.deps.agent.metadata.displayName} session to end.`);
      return;
    }
    await this.deps.messages.sendMarkdown(target, `Ended the current ${this.deps.agent.metadata.displayName} session. Send a prompt to start a new one.`);
  }

  private async handleStatus(userOpenId: string, target: ReplyTarget): Promise<void> {
    const snapshot = await this.deps.sessions.getSnapshot(userOpenId);
    const session = snapshot.session;
    if (!session) {
      await this.deps.messages.sendMarkdown(target, `No ${this.deps.agent.metadata.displayName} session yet. Send a prompt or use /projects.`);
      return;
    }
    await this.deps.messages.sendMarkdown(
      target,
      [
        `Agent: ${this.deps.agent.metadata.displayName}`,
        `Project: ${session.projectKey}`,
        `Session: ${session.agentSessionId ?? "(not started)"}`,
        `Active run: ${session.activeRunId ?? (snapshot.status === "idle" ? "(none)" : `(${statusLabel(snapshot.status)})`)}`,
      ].join("\n"),
    );
  }

  private async handleStop(userOpenId: string, target: ReplyTarget): Promise<void> {
    const result = await this.deps.sessions.stopRun(userOpenId);
    if (result.status === "starting") {
      await this.deps.messages.sendMarkdown(target, `Stop requested. The ${this.deps.agent.metadata.displayName} task is still starting.`);
      return;
    }
    if (result.status === "unsupported") {
      await this.deps.messages.sendMarkdown(target, `${this.deps.agent.metadata.displayName} does not support remote task interruption.`);
      return;
    }
    if (result.status === "none") {
      await this.deps.messages.sendMarkdown(target, `No active ${this.deps.agent.metadata.displayName} task.`);
      return;
    }
    await this.deps.messages.sendMarkdown(target, `Stopped the active ${this.deps.agent.metadata.displayName} task.`);
  }

  private async handlePermissions(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.deps.sessions.ensureSession(userOpenId, target.chatId);
    const project = getProject(this.deps.config, session.projectKey);
    await this.deps.messages.sendMarkdown(
      target,
      [
        `Agent: ${this.deps.agent.metadata.displayName}`,
        `Sandbox: ${project?.sandbox ?? this.deps.config.agent.defaultSandbox}`,
        `Approval policy: ${project?.approvalPolicy ?? this.deps.config.agent.defaultApprovalPolicy}`,
        `Approvals: ${this.deps.agent.capabilities.approvals ? "supported" : "unsupported"}`,
        `Interrupt: ${this.deps.agent.capabilities.interruptRun ? "supported" : "unsupported"}`,
      ].join("\n"),
    );
  }

  private async handleApproval(
    approvalId: string,
    approved: boolean,
    userOpenId: string,
    target: ReplyTarget,
  ): Promise<void> {
    const pending = await this.deps.store.getPendingApproval(approvalId);
    if (!pending) {
      await this.deps.messages.sendMarkdown(target, `No pending approval found for ${approvalId}.`);
      return;
    }
    if (pending.expiresAt <= Date.now()) {
      await this.deps.store.deletePendingApproval(approvalId);
      await this.deps.messages.sendMarkdown(target, `Approval ${approvalId} has expired.`);
      return;
    }
    if (pending.userOpenId !== userOpenId) {
      await this.deps.messages.sendMarkdown(target, `Only the user who triggered the ${this.deps.agent.metadata.displayName} request can resolve it.`);
      return;
    }
    if (!this.deps.agent.capabilities.approvals || !this.deps.agent.resolveApproval) {
      await this.deps.messages.sendMarkdown(target, `${this.deps.agent.metadata.displayName} does not support remote approval resolution.`);
      return;
    }

    const raw = JSON.parse(pending.payloadJson) as { requestId?: string | number };
    await this.deps.agent.resolveApproval({
      kind: pending.approvalKind,
      requestId: raw.requestId ?? pending.requestId,
      approved,
      raw,
    });
    await this.deps.store.deletePendingApproval(approvalId);
    await this.deps.messages.sendMarkdown(target, `${approved ? "Approved" : "Denied"} ${approvalId}.`);
  }

  private formatProjects(): string {
    return this.deps.config.projects.map((project) => `- ${project.key}: ${project.name}`).join("\n");
  }
}

export function commandFromActionValue(value: unknown): BotCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command === "string") return parseCommand(record.command);
  if (typeof record.approvalId === "string" && record.action === "approve") {
    return { type: "approve", approvalId: record.approvalId };
  }
  if (typeof record.approvalId === "string" && record.action === "deny") {
    return { type: "deny", approvalId: record.approvalId };
  }
  return null;
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "starting_run":
      return "starting";
    case "running_run":
      return "running";
    case "stopping_run":
      return "stopping";
    case "ending_session":
      return "ending";
    case "resetting_session":
      return "resetting";
    case "idle":
      return "none";
    default:
      return status;
  }
}
