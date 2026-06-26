import { BotCommandHandler, commandFromActionValue } from "./command-handler.js";
import { parseCommand } from "./commands.js";
import { TurnStatusReporter } from "./turn-status-reporter.js";
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
import { SessionManager, type PromptClaim } from "../session/session-manager.js";
import type { PendingApproval, StateStore } from "../store/types.js";

export class BotService {
  private readonly eventTasks = new Set<Promise<void>>();
  private readonly sessions: SessionManager;
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
    this.sessions = new SessionManager(this.config, this.store, this.codex);
    this.commands = new BotCommandHandler({
      config: this.config,
      messages: this.messages,
      codex: this.codex,
      store: this.store,
      sessions: this.sessions,
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
    while (this.eventTasks.size > 0) {
      await Promise.allSettled([...this.eventTasks]);
    }
    await this.sessions.waitForIdle();
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
    const snapshot = await this.sessions.getSnapshot(event.operatorId);
    if (!snapshot.session?.lastChatId) return;
    const command = parseCommand(event.eventKey.startsWith("/") ? event.eventKey : `/${event.eventKey}`);
    if (!command) return;
    await this.commands.handle(command, event.operatorId, { chatId: snapshot.session.lastChatId });
  }

  private async handlePrompt(event: FeishuMessageEvent, target: ReplyTarget): Promise<void> {
    const claimResult = await this.sessions.beginPrompt(event.senderId, event.chatId);
    if (!claimResult.ok) {
      if (claimResult.reason === "missing_project") {
        await this.messages.sendMarkdown(target, "Current project is no longer configured. Use /projects and /use <project>.");
        return;
      }
      await this.messages.sendMarkdown(target, "A Codex task is already running. Please wait or use /stop.");
      return;
    }

    this.sessions.runPromptTask(claimResult.claim, () =>
      this.runPromptTurn(event, target, claimResult.claim)
      .catch(async (error) => {
        await this.messages.sendMarkdown(target, `Codex turn failed: ${errorMessage(error)}`);
      }),
    );
  }

  private async runPromptTurn(
    event: FeishuMessageEvent,
    target: ReplyTarget,
    claim: PromptClaim,
  ): Promise<void> {
    await this.sendPromptAccepted(target, claim.project.key);

    if (await this.sessions.isStopRequested(claim)) {
      await this.messages.sendMarkdown(target, "Codex task was stopped before it started.");
      return;
    }

    const threadResult = await this.sessions.ensureThread(claim);
    if (!threadResult.ok || await this.sessions.isStopRequested(claim)) {
      await this.messages.sendMarkdown(target, "Codex task was stopped before it started.");
      return;
    }

    const reporter = new TurnStatusReporter(this.messages, target, claim.project.key);
    await reporter.start();
    let currentTurnId: string | undefined;

    try {
      for await (const codexEvent of this.codex.startTurn({
        threadId: threadResult.thread.id,
        project: claim.project,
        text: event.content,
        clientUserMessageId: event.messageId,
      })) {
        await this.handleCodexEvent(codexEvent, claim, target, reporter);
        if (codexEvent.type === "turn_started") {
          currentTurnId = codexEvent.turnId;
        }
      }
    } catch (error) {
      await reporter.fail(errorMessage(error));
      await this.sessions.failTurn(claim, currentTurnId);
      await this.messages.sendMarkdown(target, `Codex turn failed: ${errorMessage(error)}`);
      return;
    }

    const finalText = reporter.finalText();
    if (finalText) {
      await this.messages.sendMarkdown(target, finalText, { replyTo: event.messageId });
    } else if (!(await this.sessions.isStopRequested(claim))) {
      const turnStatus = reporter.turnStatus();
      if (turnStatus === "completed") {
        await this.messages.sendMarkdown(target, "Codex completed without textual output.", { replyTo: event.messageId });
      } else if (turnStatus !== "interrupted") {
        await this.messages.sendMarkdown(target, `Codex turn finished with status: ${turnStatus}.`, {
          replyTo: event.messageId,
        });
      }
    }
    if (currentTurnId) await this.sessions.completeTurn(claim, currentTurnId);
  }

  private async handleCodexEvent(
    event: CodexEvent,
    claim: PromptClaim,
    target: ReplyTarget,
    reporter: TurnStatusReporter,
  ): Promise<void> {
    switch (event.type) {
      case "turn_started": {
        await reporter.turnStarted(event.turnId);
        const result = await this.sessions.markTurnStarted(claim, event.threadId, event.turnId);
        if (result.shouldInterrupt) {
          await this.codex.interruptTurn({ threadId: event.threadId, turnId: event.turnId }).catch(() => undefined);
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
          userOpenId: claim.userOpenId,
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
        await this.sessions.completeTurn(claim, event.turnId);
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

  private isAllowedUser(openId: string): boolean {
    const allowed = this.config.feishu.allowedUsers;
    return allowed.length === 0 || allowed.includes(openId);
  }

  private isAllowedGroupMessage(event: FeishuMessageEvent): boolean {
    const allowedChats = this.config.feishu.allowedChats;
    if (allowedChats.length > 0 && !allowedChats.includes(event.chatId)) return false;
    return event.mentionedBot;
  }
}

function createShortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
