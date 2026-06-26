import { commandHelp, parseCommand, type BotCommand } from "./commands.js";
import { getProject } from "../config/index.js";
import type { AppConfig } from "../config/types.js";
import type { CodexDriver } from "../codex/types.js";
import type { FeishuMessagePort, ReplyTarget } from "../feishu/types.js";
import type { CurrentSession, StateStore } from "../store/types.js";

type ActiveTurn = {
  threadId: string;
  turnId: string;
};

type BotCommandHandlerDeps = {
  config: AppConfig;
  messages: FeishuMessagePort;
  codex: CodexDriver;
  store: StateStore;
  ensureSession(userOpenId: string, chatId: string): Promise<CurrentSession>;
  isUserBusy(userOpenId: string): boolean;
  isSessionBusy(userOpenId: string, session: CurrentSession): boolean;
  getTurnTask(userOpenId: string): Promise<void> | undefined;
  getRuntimeActiveTurn(userOpenId: string): ActiveTurn | undefined;
  requestStop(userOpenId: string): void;
  clearRuntimeActiveTurn(userOpenId: string): void;
  rememberLoadedThread(threadId: string): void;
};

export class BotCommandHandler {
  constructor(private readonly deps: BotCommandHandlerDeps) {}

  async handle(command: BotCommand, userOpenId: string, target: ReplyTarget): Promise<void> {
    switch (command.type) {
      case "help":
        await this.deps.messages.sendMarkdown(target, commandHelp());
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
    const project = getProject(this.deps.config, projectKey);
    if (!project) {
      await this.deps.messages.sendMarkdown(target, `Unknown project: ${projectKey}\n\n${this.formatProjects()}`);
      return;
    }
    const current = await this.deps.ensureSession(userOpenId, target.chatId);
    if (this.deps.isSessionBusy(userOpenId, current)) {
      await this.deps.messages.sendMarkdown(target, "A task is running. Use /stop before switching projects.");
      return;
    }
    await this.deps.store.upsertCurrentSession({
      userOpenId,
      projectKey: project.key,
      codexThreadId: null,
      activeTurnId: null,
      lastChatId: target.chatId,
      updatedAt: Date.now(),
    });
    await this.deps.messages.sendMarkdown(target, `Switched to project ${project.key}: ${project.name}`);
  }

  private async handleNewSession(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.deps.ensureSession(userOpenId, target.chatId);
    const activeTask = this.deps.getTurnTask(userOpenId);
    const activeTurn = getSessionActiveTurn(session) ?? this.deps.getRuntimeActiveTurn(userOpenId);
    if (activeTask) this.deps.requestStop(userOpenId);
    if (activeTurn) {
      await this.deps.codex.interruptTurn(activeTurn).catch(() => {
        // The old app-server process may already be gone; /new should still create a fresh session.
      });
      this.deps.clearRuntimeActiveTurn(userOpenId);
    }
    if (activeTask) await activeTask.catch(() => undefined);

    const project = getProject(this.deps.config, session.projectKey);
    if (!project) throw new Error(`Configured project missing: ${session.projectKey}`);
    const thread = await this.deps.codex.startThread({ project });
    this.deps.rememberLoadedThread(thread.id);
    await this.deps.store.upsertCurrentSession({
      ...session,
      codexThreadId: thread.id,
      activeTurnId: null,
      lastChatId: target.chatId,
      updatedAt: Date.now(),
    });
    await this.deps.messages.sendMarkdown(target, `Started a new Codex session for ${project.key}.`);
  }

  private async handleEndSession(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.deps.store.getCurrentSession(userOpenId);
    const activeTask = this.deps.getTurnTask(userOpenId);
    const activeTurn = getSessionActiveTurn(session) ?? this.deps.getRuntimeActiveTurn(userOpenId);

    if (!session && !activeTask && !activeTurn) {
      await this.deps.messages.sendMarkdown(target, "No Codex session to end.");
      return;
    }

    if (activeTask) this.deps.requestStop(userOpenId);
    if (activeTurn) {
      await this.deps.codex.interruptTurn(activeTurn).catch(() => {
        // Ending a session should still clear local state if Codex already exited.
      });
      this.deps.clearRuntimeActiveTurn(userOpenId);
      await this.deps.store.clearActiveTurn(userOpenId, activeTurn.turnId);
    }
    if (activeTask) await activeTask.catch(() => undefined);

    if (session) {
      await this.deps.store.upsertCurrentSession({
        ...session,
        codexThreadId: null,
        activeTurnId: null,
        lastChatId: target.chatId,
        updatedAt: Date.now(),
      });
    }
    await this.deps.store.deletePendingApprovalsForUser(userOpenId);
    await this.deps.messages.sendMarkdown(target, "Ended the current Codex session. Send a prompt to start a new one.");
  }

  private async handleStatus(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.deps.store.getCurrentSession(userOpenId);
    if (!session) {
      await this.deps.messages.sendMarkdown(target, "No Codex session yet. Send a prompt or use /projects.");
      return;
    }
    await this.deps.messages.sendMarkdown(
      target,
      [
        `Project: ${session.projectKey}`,
        `Thread: ${session.codexThreadId ?? "(not started)"}`,
        `Active turn: ${session.activeTurnId ?? (this.deps.isUserBusy(userOpenId) ? "(starting)" : "(none)")}`,
      ].join("\n"),
    );
  }

  private async handleStop(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.deps.store.getCurrentSession(userOpenId);
    const activeTurn = getSessionActiveTurn(session) ?? this.deps.getRuntimeActiveTurn(userOpenId);
    if (!activeTurn) {
      if (this.deps.isUserBusy(userOpenId)) {
        this.deps.requestStop(userOpenId);
        await this.deps.messages.sendMarkdown(target, "Stop requested. The Codex task is still starting.");
        return;
      }
      await this.deps.messages.sendMarkdown(target, "No active Codex task.");
      return;
    }
    this.deps.requestStop(userOpenId);
    await this.deps.codex.interruptTurn(activeTurn);
    this.deps.clearRuntimeActiveTurn(userOpenId);
    await this.deps.store.clearActiveTurn(userOpenId, activeTurn.turnId);
    await this.deps.messages.sendMarkdown(target, "Stopped the active Codex task.");
  }

  private async handlePermissions(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.deps.ensureSession(userOpenId, target.chatId);
    const project = getProject(this.deps.config, session.projectKey);
    await this.deps.messages.sendMarkdown(
      target,
      [
        `Sandbox: ${project?.sandbox ?? this.deps.config.codex.defaultSandbox}`,
        `Approval policy: ${project?.approvalPolicy ?? this.deps.config.codex.defaultApprovalPolicy}`,
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
      await this.deps.messages.sendMarkdown(target, "Only the user who triggered the Codex request can resolve it.");
      return;
    }

    const raw = JSON.parse(pending.payloadJson) as { requestId?: string | number };
    await this.deps.codex.resolveApproval({
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

function getSessionActiveTurn(session: CurrentSession | null): ActiveTurn | undefined {
  if (!session?.codexThreadId || !session.activeTurnId) return undefined;
  return { threadId: session.codexThreadId, turnId: session.activeTurnId };
}
