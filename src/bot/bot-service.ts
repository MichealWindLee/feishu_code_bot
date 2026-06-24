import { AsyncQueue } from "../shared/async-queue.js";
import { commandHelp, parseCommand, type BotCommand } from "./commands.js";
import { getProject } from "../config/index.js";
import type { AppConfig } from "../config/types.js";
import type { CodexDriver, CodexEvent } from "../codex/types.js";
import type {
  FeishuBotMenuEvent,
  FeishuCardActionEvent,
  FeishuGateway,
  FeishuInboundEvent,
  FeishuMessageEvent,
  FeishuMessagePort,
  ReplyTarget,
} from "../feishu/types.js";
import type { CurrentSession, PendingApproval, StateStore } from "../store/types.js";

export class BotService {
  private readonly loadedThreads = new Set<string>();
  private readonly eventTasks = new Set<Promise<void>>();
  private readonly turnTasks = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, { threadId: string; turnId: string }>();
  private readonly startingUsers = new Set<string>();
  private readonly stopRequestedUsers = new Set<string>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly gateway: FeishuGateway,
    private readonly messages: FeishuMessagePort,
    private readonly codex: CodexDriver,
    private readonly store: StateStore,
  ) {}

  async start(): Promise<void> {
    await this.store.cleanupExpired(Date.now());
    await this.store.markInterruptedActiveSessions();
    await this.codex.start();
    this.gateway.onEvent((event) => {
      void this.handleEvent(event).catch((error) => {
        console.error("Failed to handle Feishu event", error);
      });
    });
    await this.gateway.start();
    this.cleanupTimer = setInterval(() => {
      void this.store.cleanupExpired(Date.now()).catch((error) => {
        console.error("Failed to cleanup expired state", error);
      });
    }, 60_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.gateway.stop();
    await this.codex.stop();
    await this.waitForIdle();
    await this.store.close();
  }

  async handleEvent(event: FeishuInboundEvent): Promise<void> {
    if ("eventId" in event) {
      const isNew = await this.store.rememberEvent(event.eventId, Date.now() + this.config.bot.eventDedupTtlMs);
      if (!isNew) return;
    }

    if (event.kind === "connection") {
      if (event.status === "error") console.error("Feishu connection error", event.error);
      return;
    }

    this.enqueueEvent(event);
  }

  async waitForIdle(): Promise<void> {
    while (this.eventTasks.size > 0 || this.turnTasks.size > 0) {
      await Promise.allSettled([...this.eventTasks, ...this.turnTasks.values()]);
    }
  }

  private enqueueEvent(event: FeishuInboundEvent): void {
    if (this.stopping) return;
    const task = Promise.resolve()
      .then(() => this.processEvent(event))
      .catch((error) => {
        console.error("Failed to process Feishu event", error);
      })
      .finally(() => {
        this.eventTasks.delete(task);
      });
    this.eventTasks.add(task);
  }

  private async processEvent(event: FeishuInboundEvent): Promise<void> {
    switch (event.kind) {
      case "message":
        await this.handleMessage(event);
        break;
      case "card_action":
        await this.handleCardAction(event);
        break;
      case "bot_menu":
        await this.handleBotMenu(event);
        break;
      default:
        break;
    }
  }

  private async handleMessage(event: FeishuMessageEvent): Promise<void> {
    if (!this.isAllowedUser(event.senderId)) return;
    if (event.chatType === "group" && !this.isAllowedGroupMessage(event)) return;

    const target: ReplyTarget = { chatId: event.chatId, messageId: event.messageId };
    const command = parseCommand(event.content);
    if (command) {
      await this.handleCommand(command, event.senderId, target);
      return;
    }

    if (event.content.trim().startsWith("/")) {
      await this.messages.sendMarkdown(target, "Unknown command. Use /help to see available commands.");
      return;
    }

    await this.handlePrompt(event, target);
  }

  private async handleCardAction(event: FeishuCardActionEvent): Promise<void> {
    if (!this.isAllowedUser(event.operatorId)) return;
    const command = commandFromActionValue(event.value);
    if (!command) return;
    await this.handleCommand(command, event.operatorId, { chatId: event.chatId, messageId: event.messageId });
  }

  private async handleBotMenu(event: FeishuBotMenuEvent): Promise<void> {
    if (!this.isAllowedUser(event.operatorId)) return;
    const session = await this.store.getCurrentSession(event.operatorId);
    if (!session?.lastChatId) return;
    const command = parseCommand(event.eventKey.startsWith("/") ? event.eventKey : `/${event.eventKey}`);
    if (!command) return;
    await this.handleCommand(command, event.operatorId, { chatId: session.lastChatId });
  }

  private async handleCommand(command: BotCommand, userOpenId: string, target: ReplyTarget): Promise<void> {
    switch (command.type) {
      case "help":
        await this.messages.sendMarkdown(target, commandHelp());
        return;
      case "projects":
        await this.messages.sendMarkdown(target, this.formatProjects());
        return;
      case "use":
        await this.handleUseProject(command.projectKey, userOpenId, target);
        return;
      case "new":
        await this.handleNewSession(userOpenId, target);
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
        await this.messages.sendMarkdown(target, "Unsupported command.");
    }
  }

  private async handlePrompt(event: FeishuMessageEvent, target: ReplyTarget): Promise<void> {
    if (this.isUserBusy(event.senderId)) {
      await this.messages.sendMarkdown(target, "A Codex task is already running. Please wait or use /stop.");
      return;
    }
    this.startingUsers.add(event.senderId);

    const session = await this.ensureSession(event.senderId, event.chatId);
    if (session.activeTurnId) {
      this.startingUsers.delete(event.senderId);
      await this.messages.sendMarkdown(target, "A Codex task is already running. Please wait or use /stop.");
      return;
    }

    const project = getProject(this.config, session.projectKey);
    if (!project) {
      this.startingUsers.delete(event.senderId);
      await this.messages.sendMarkdown(target, "Current project is no longer configured. Use /projects and /use <project>.");
      return;
    }

    const task = Promise.resolve()
      .then(() => this.runPromptTurn(event, target, session, project))
      .catch(async (error) => {
        await this.messages.sendMarkdown(target, `Codex turn failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.startingUsers.delete(event.senderId);
        this.stopRequestedUsers.delete(event.senderId);
        this.turnTasks.delete(event.senderId);
      });
    this.turnTasks.set(event.senderId, task);
  }

  private async runPromptTurn(
    event: FeishuMessageEvent,
    target: ReplyTarget,
    session: CurrentSession,
    project: NonNullable<ReturnType<typeof getProject>>,
  ): Promise<void> {
    await this.sendPromptAccepted(target, project.key);

    if (this.stopRequestedUsers.has(event.senderId)) {
      await this.messages.sendMarkdown(target, "Codex task was stopped before it started.");
      return;
    }

    const thread = await this.ensureThread(session, project);
    if (this.stopRequestedUsers.has(event.senderId)) {
      await this.messages.sendMarkdown(target, "Codex task was stopped before it started.");
      return;
    }

    const output = new AsyncQueue<string>();
    const streamPromise = this.messages.streamMarkdown(target, output, { replyTo: event.messageId });
    let currentTurnId: string | undefined;

    try {
      for await (const codexEvent of this.codex.startTurn({
        threadId: thread.id,
        project,
        text: event.content,
        clientUserMessageId: event.messageId,
      })) {
        await this.handleCodexEvent(codexEvent, event.senderId, target, output);
        if (codexEvent.type === "turn_started") {
          currentTurnId = codexEvent.turnId;
          this.startingUsers.delete(event.senderId);
          if (this.stopRequestedUsers.has(event.senderId)) {
            await this.codex.interruptTurn({ threadId: thread.id, turnId: codexEvent.turnId });
          }
        }
      }
    } catch (error) {
      output.close();
      await streamPromise.catch(() => undefined);
      if (currentTurnId) await this.store.clearActiveTurn(event.senderId, currentTurnId);
      if (currentTurnId && this.activeTurns.get(event.senderId)?.turnId === currentTurnId) {
        this.activeTurns.delete(event.senderId);
      }
      await this.messages.sendMarkdown(target, `Codex turn failed: ${errorMessage(error)}`);
      return;
    }

    output.close();
    await streamPromise.catch(async (error) => {
      await this.messages.sendMarkdown(target, `Codex output stream failed: ${errorMessage(error)}`);
    });
    if (currentTurnId) await this.store.clearActiveTurn(event.senderId, currentTurnId);
    if (currentTurnId && this.activeTurns.get(event.senderId)?.turnId === currentTurnId) {
      this.activeTurns.delete(event.senderId);
    }
  }

  private async handleCodexEvent(
    event: CodexEvent,
    userOpenId: string,
    target: ReplyTarget,
    output: AsyncQueue<string>,
  ): Promise<void> {
    switch (event.type) {
      case "turn_started": {
        this.activeTurns.set(userOpenId, { threadId: event.threadId, turnId: event.turnId });
        const session = await this.store.getCurrentSession(userOpenId);
        if (session) {
          await this.store.upsertCurrentSession({
            ...session,
            activeTurnId: event.turnId,
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "agent_delta":
        output.push(event.delta);
        break;
      case "approval_requested": {
        const shortId = createShortId();
        const pending: PendingApproval = {
          approvalShortId: shortId,
          userOpenId,
          codexThreadId: event.approval.threadId,
          turnId: event.approval.turnId,
          requestId: String(event.approval.requestId),
          approvalKind: event.approval.kind,
          payloadJson: JSON.stringify(event.approval.raw),
          expiresAt: Date.now() + this.config.bot.approvalTtlMs,
        };
        await this.store.savePendingApproval(pending);
        await this.messages.sendMarkdown(
          target,
          [
            `Approval required: ${event.approval.title}`,
            "",
            event.approval.body,
            "",
            `Reply with /approve ${shortId} or /deny ${shortId}.`,
          ].join("\n"),
        );
        break;
      }
      case "turn_completed":
        if (this.activeTurns.get(userOpenId)?.turnId === event.turnId) {
          this.activeTurns.delete(userOpenId);
        }
        await this.store.clearActiveTurn(userOpenId, event.turnId);
        break;
      case "error":
        await this.messages.sendMarkdown(target, `Codex error: ${event.message}`);
        break;
      default:
        break;
    }
  }

  private async handleUseProject(projectKey: string, userOpenId: string, target: ReplyTarget): Promise<void> {
    const project = getProject(this.config, projectKey);
    if (!project) {
      await this.messages.sendMarkdown(target, `Unknown project: ${projectKey}\n\n${this.formatProjects()}`);
      return;
    }
    const current = await this.ensureSession(userOpenId, target.chatId);
    if (this.isSessionBusy(userOpenId, current)) {
      await this.messages.sendMarkdown(target, "A task is running. Use /stop before switching projects.");
      return;
    }
    await this.store.upsertCurrentSession({
      userOpenId,
      projectKey: project.key,
      codexThreadId: null,
      activeTurnId: null,
      lastChatId: target.chatId,
      updatedAt: Date.now(),
    });
    await this.messages.sendMarkdown(target, `Switched to project ${project.key}: ${project.name}`);
  }

  private async handleNewSession(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.ensureSession(userOpenId, target.chatId);
    const activeTask = this.turnTasks.get(userOpenId);
    const activeTurn = getActiveTurn(session) ?? this.activeTurns.get(userOpenId);
    if (activeTask) this.stopRequestedUsers.add(userOpenId);
    if (activeTurn) {
      await this.codex.interruptTurn(activeTurn).catch(() => {
        // The old app-server process may already be gone; /new should still create a fresh session.
      });
    }
    if (activeTask) await activeTask.catch(() => undefined);
    const project = getProject(this.config, session.projectKey);
    if (!project) throw new Error(`Configured project missing: ${session.projectKey}`);
    const thread = await this.codex.startThread({ project });
    this.loadedThreads.add(thread.id);
    await this.store.upsertCurrentSession({
      ...session,
      codexThreadId: thread.id,
      activeTurnId: null,
      lastChatId: target.chatId,
      updatedAt: Date.now(),
    });
    await this.messages.sendMarkdown(target, `Started a new Codex session for ${project.key}.`);
  }

  private async handleStatus(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.store.getCurrentSession(userOpenId);
    if (!session) {
      await this.messages.sendMarkdown(target, "No Codex session yet. Send a prompt or use /projects.");
      return;
    }
    await this.messages.sendMarkdown(
      target,
      [
        `Project: ${session.projectKey}`,
        `Thread: ${session.codexThreadId ?? "(not started)"}`,
        `Active turn: ${session.activeTurnId ?? (this.isUserBusy(userOpenId) ? "(starting)" : "(none)")}`,
      ].join("\n"),
    );
  }

  private async handleStop(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.store.getCurrentSession(userOpenId);
    const activeTurn = getActiveTurn(session) ?? this.activeTurns.get(userOpenId);
    if (!activeTurn) {
      if (this.isUserBusy(userOpenId)) {
        this.stopRequestedUsers.add(userOpenId);
        await this.messages.sendMarkdown(target, "Stop requested. The Codex task is still starting.");
        return;
      }
      await this.messages.sendMarkdown(target, "No active Codex task.");
      return;
    }
    this.stopRequestedUsers.add(userOpenId);
    await this.codex.interruptTurn(activeTurn);
    this.activeTurns.delete(userOpenId);
    await this.store.clearActiveTurn(userOpenId, activeTurn.turnId);
    await this.messages.sendMarkdown(target, "Stopped the active Codex task.");
  }

  private async handlePermissions(userOpenId: string, target: ReplyTarget): Promise<void> {
    const session = await this.ensureSession(userOpenId, target.chatId);
    const project = getProject(this.config, session.projectKey);
    await this.messages.sendMarkdown(
      target,
      [
        `Sandbox: ${project?.sandbox ?? this.config.codex.defaultSandbox}`,
        `Approval policy: ${project?.approvalPolicy ?? this.config.codex.defaultApprovalPolicy}`,
      ].join("\n"),
    );
  }

  private async handleApproval(
    approvalId: string,
    approved: boolean,
    userOpenId: string,
    target: ReplyTarget,
  ): Promise<void> {
    const pending = await this.store.getPendingApproval(approvalId);
    if (!pending) {
      await this.messages.sendMarkdown(target, `No pending approval found for ${approvalId}.`);
      return;
    }
    if (pending.expiresAt <= Date.now()) {
      await this.store.deletePendingApproval(approvalId);
      await this.messages.sendMarkdown(target, `Approval ${approvalId} has expired.`);
      return;
    }
    if (pending.userOpenId !== userOpenId) {
      await this.messages.sendMarkdown(target, "Only the user who triggered the Codex request can resolve it.");
      return;
    }
    const raw = JSON.parse(pending.payloadJson) as { requestId?: string | number };
    await this.codex.resolveApproval({
      kind: pending.approvalKind,
      requestId: raw.requestId ?? pending.requestId,
      approved,
      raw,
    });
    await this.store.deletePendingApproval(approvalId);
    await this.messages.sendMarkdown(target, `${approved ? "Approved" : "Denied"} ${approvalId}.`);
  }

  private async sendPromptAccepted(target: ReplyTarget, projectKey: string): Promise<void> {
    if (!this.config.bot.debugPromptAcceptedFeedback) return;
    try {
      await this.messages.sendMarkdown(
        target,
        [`已收到，已进入 ${projectKey} 的 Codex 处理队列。`, "可用 /status 查看状态，/stop 中止。"].join("\n"),
      );
    } catch (error) {
      console.error("Failed to send prompt accepted feedback", error);
    }
  }

  private async ensureSession(userOpenId: string, chatId: string): Promise<CurrentSession> {
    const current = await this.store.getCurrentSession(userOpenId);
    if (current) {
      const updated = { ...current, lastChatId: chatId, updatedAt: Date.now() };
      await this.store.upsertCurrentSession(updated);
      return updated;
    }
    const session: CurrentSession = {
      userOpenId,
      projectKey: this.config.projects[0].key,
      codexThreadId: null,
      activeTurnId: null,
      lastChatId: chatId,
      updatedAt: Date.now(),
    };
    await this.store.upsertCurrentSession(session);
    return session;
  }

  private async ensureThread(session: CurrentSession, project: NonNullable<ReturnType<typeof getProject>>) {
    if (session.codexThreadId) {
      if (!this.loadedThreads.has(session.codexThreadId)) {
        const thread = await this.codex.resumeThread(session.codexThreadId, {
          threadId: session.codexThreadId,
          project,
        });
        this.loadedThreads.add(thread.id);
        return thread;
      }
      return { id: session.codexThreadId };
    }

    const thread = await this.codex.startThread({ project });
    this.loadedThreads.add(thread.id);
    await this.store.upsertCurrentSession({
      ...session,
      codexThreadId: thread.id,
      updatedAt: Date.now(),
    });
    return thread;
  }

  private isAllowedUser(openId: string): boolean {
    const allowed = this.config.feishu.allowedUsers;
    return allowed.length === 0 || allowed.includes(openId);
  }

  private isAllowedGroupMessage(event: FeishuMessageEvent): boolean {
    const allowedChats = this.config.feishu.allowedChats;
    if (allowedChats.length > 0 && !allowedChats.includes(event.chatId)) return false;
    return event.mentionedBot;
  }

  private isUserBusy(userOpenId: string): boolean {
    return this.startingUsers.has(userOpenId) || this.turnTasks.has(userOpenId) || this.activeTurns.has(userOpenId);
  }

  private isSessionBusy(userOpenId: string, session: CurrentSession): boolean {
    return Boolean(session.activeTurnId) || this.isUserBusy(userOpenId);
  }

  private formatProjects(): string {
    return this.config.projects.map((project) => `- ${project.key}: ${project.name}`).join("\n");
  }
}

function commandFromActionValue(value: unknown): BotCommand | null {
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

function createShortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getActiveTurn(session: CurrentSession | null): { threadId: string; turnId: string } | undefined {
  if (!session?.codexThreadId || !session.activeTurnId) return undefined;
  return { threadId: session.codexThreadId, turnId: session.activeTurnId };
}
