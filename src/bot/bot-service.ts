import { BotCommandHandler, commandFromActionValue } from "./command-handler.js";
import { parseCommand } from "./commands.js";
import { TurnStatusReporter } from "./turn-status-reporter.js";
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
  private readonly commands: BotCommandHandler;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly gateway: FeishuGateway,
    private readonly messages: FeishuMessagePort,
    private readonly codex: CodexDriver,
    private readonly store: StateStore,
  ) {
    this.commands = new BotCommandHandler({
      config: this.config,
      messages: this.messages,
      codex: this.codex,
      store: this.store,
      ensureSession: (userOpenId, chatId) => this.ensureSession(userOpenId, chatId),
      isUserBusy: (userOpenId) => this.isUserBusy(userOpenId),
      isSessionBusy: (userOpenId, session) => this.isSessionBusy(userOpenId, session),
      getTurnTask: (userOpenId) => this.turnTasks.get(userOpenId),
      getRuntimeActiveTurn: (userOpenId) => this.activeTurns.get(userOpenId),
      requestStop: (userOpenId) => this.stopRequestedUsers.add(userOpenId),
      clearRuntimeActiveTurn: (userOpenId) => this.activeTurns.delete(userOpenId),
      rememberLoadedThread: (threadId) => this.loadedThreads.add(threadId),
    });
  }

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
      await this.commands.handle(command, event.senderId, target);
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
    await this.commands.handle(command, event.operatorId, { chatId: event.chatId, messageId: event.messageId });
  }

  private async handleBotMenu(event: FeishuBotMenuEvent): Promise<void> {
    if (!this.isAllowedUser(event.operatorId)) return;
    const session = await this.store.getCurrentSession(event.operatorId);
    if (!session?.lastChatId) return;
    const command = parseCommand(event.eventKey.startsWith("/") ? event.eventKey : `/${event.eventKey}`);
    if (!command) return;
    await this.commands.handle(command, event.operatorId, { chatId: session.lastChatId });
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

    const reporter = new TurnStatusReporter(this.messages, target, project.key);
    await reporter.start();
    let currentTurnId: string | undefined;

    try {
      for await (const codexEvent of this.codex.startTurn({
        threadId: thread.id,
        project,
        text: event.content,
        clientUserMessageId: event.messageId,
      })) {
        await this.handleCodexEvent(codexEvent, event.senderId, target, reporter);
        if (codexEvent.type === "turn_started") {
          currentTurnId = codexEvent.turnId;
          this.startingUsers.delete(event.senderId);
          if (this.stopRequestedUsers.has(event.senderId)) {
            await this.codex.interruptTurn({ threadId: thread.id, turnId: codexEvent.turnId });
          }
        }
      }
    } catch (error) {
      await reporter.fail(errorMessage(error));
      if (currentTurnId) await this.store.clearActiveTurn(event.senderId, currentTurnId);
      if (currentTurnId && this.activeTurns.get(event.senderId)?.turnId === currentTurnId) {
        this.activeTurns.delete(event.senderId);
      }
      await this.messages.sendMarkdown(target, `Codex turn failed: ${errorMessage(error)}`);
      return;
    }

    const finalText = reporter.finalText();
    if (finalText) {
      await this.messages.sendMarkdown(target, finalText, { replyTo: event.messageId });
    } else if (!this.stopRequestedUsers.has(event.senderId)) {
      const turnStatus = reporter.turnStatus();
      if (turnStatus === "completed") {
        await this.messages.sendMarkdown(target, "Codex completed without textual output.", { replyTo: event.messageId });
      } else if (turnStatus !== "interrupted") {
        await this.messages.sendMarkdown(target, `Codex turn finished with status: ${turnStatus}.`, {
          replyTo: event.messageId,
        });
      }
    }
    if (currentTurnId) await this.store.clearActiveTurn(event.senderId, currentTurnId);
    if (currentTurnId && this.activeTurns.get(event.senderId)?.turnId === currentTurnId) {
      this.activeTurns.delete(event.senderId);
    }
  }

  private async handleCodexEvent(
    event: CodexEvent,
    userOpenId: string,
    target: ReplyTarget,
    reporter: TurnStatusReporter,
  ): Promise<void> {
    switch (event.type) {
      case "turn_started": {
        await reporter.turnStarted(event.turnId);
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
        reporter.appendAgentDelta(event.delta);
        break;
      case "plan_updated":
        await reporter.planUpdated(event.explanation, event.steps);
        break;
      case "item_started":
        await reporter.itemStarted(event.item);
        break;
      case "item_completed":
        await reporter.itemCompleted(event.item);
        break;
      case "diff_updated":
        await reporter.diffUpdated(event.changedFiles);
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
        await reporter.approvalRequested(event.approval.title);
        break;
      }
      case "turn_completed":
        await reporter.completed(event.status);
        if (this.activeTurns.get(userOpenId)?.turnId === event.turnId) {
          this.activeTurns.delete(userOpenId);
        }
        await this.store.clearActiveTurn(userOpenId, event.turnId);
        break;
      case "warning":
        await reporter.warning(event.message);
        break;
      case "error":
        await reporter.fail(event.message);
        await this.messages.sendMarkdown(target, `Codex error: ${event.message}`);
        break;
      default:
        break;
    }
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
}

function createShortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
