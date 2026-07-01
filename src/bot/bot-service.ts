import { BotCommandHandler, commandFromActionValue } from "./command-handler.js";
import { parseCommand } from "./commands.js";
import { RunStatusReporter } from "./run-status-reporter.js";
import type { AgentRunEvent, CodeAgentDriver } from "../agent/types.js";
import type { AppConfig } from "../config/types.js";
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
    private readonly agent: CodeAgentDriver,
    private readonly store: StateStore,
  ) {
    this.sessions = new SessionManager(this.config, this.store, this.agent);
    this.commands = new BotCommandHandler({
      config: this.config,
      messages: this.messages,
      agent: this.agent,
      store: this.store,
      sessions: this.sessions,
    });
  }

  async start(): Promise<void> {
    await this.store.cleanupExpired(Date.now());
    await this.store.markInterruptedActiveSessions();
    await this.agent.start();
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
    await this.agent.stop();
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
      await this.messages.sendMarkdown(target, `A ${this.agent.metadata.displayName} task is already running. Please wait or use /stop.`);
      return;
    }

    this.sessions.runPromptTask(claimResult.claim, () =>
      this.runPrompt(event, target, claimResult.claim)
      .catch(async (error) => {
        await this.messages.sendMarkdown(target, `${this.agent.metadata.displayName} run failed: ${errorMessage(error)}`);
      }),
    );
  }

  private async runPrompt(
    event: FeishuMessageEvent,
    target: ReplyTarget,
    claim: PromptClaim,
  ): Promise<void> {
    await this.sendPromptAccepted(target, claim.project.key);

    if (await this.sessions.isStopRequested(claim)) {
      await this.messages.sendMarkdown(target, `${this.agent.metadata.displayName} task was stopped before it started.`);
      return;
    }

    const sessionResult = await this.sessions.ensureAgentSession(claim);
    if (!sessionResult.ok || await this.sessions.isStopRequested(claim)) {
      await this.messages.sendMarkdown(target, `${this.agent.metadata.displayName} task was stopped before it started.`);
      return;
    }

    const reporter = new RunStatusReporter(
      this.messages,
      target,
      claim.project.key,
      this.agent.metadata.displayName,
      this.agent.capabilities,
    );
    await reporter.start();
    let currentRunId: string | undefined;

    try {
      for await (const agentEvent of this.agent.startRun({
        sessionId: sessionResult.agentSession.id,
        project: claim.project,
        text: event.content,
        clientUserMessageId: event.messageId,
      })) {
        await this.handleAgentEvent(agentEvent, claim, target, reporter);
        if (agentEvent.type === "run_started") {
          currentRunId = agentEvent.runId;
        }
      }
    } catch (error) {
      await reporter.fail(errorMessage(error));
      await this.sessions.failRun(claim, currentRunId);
      await this.messages.sendMarkdown(target, `${this.agent.metadata.displayName} run event failed: ${errorMessage(error)}`);
      return;
    }

    const finalText = reporter.finalText();
    if (finalText) {
      await this.messages.sendMarkdown(target, finalText, { replyTo: event.messageId });
    } else if (!(await this.sessions.isStopRequested(claim))) {
      const runStatus = reporter.runStatus();
      if (runStatus === "completed") {
        await this.messages.sendMarkdown(target, `${this.agent.metadata.displayName} completed without textual output.`, { replyTo: event.messageId });
      } else if (runStatus !== "interrupted") {
        await this.messages.sendMarkdown(target, `${this.agent.metadata.displayName} run finished with status: ${runStatus}.`, {
          replyTo: event.messageId,
        });
      }
    }
    if (currentRunId) await this.sessions.completeRun(claim, currentRunId);
  }

  private async handleAgentEvent(
    event: AgentRunEvent,
    claim: PromptClaim,
    target: ReplyTarget,
    reporter: RunStatusReporter,
  ): Promise<void> {
    switch (event.type) {
      case "run_started": {
        await reporter.runStarted();
        const result = await this.sessions.markRunStarted(claim, event.sessionId, event.runId);
        if (result.shouldInterrupt && this.agent.capabilities.interruptRun) {
          await this.agent.interruptRun?.({ sessionId: event.sessionId, runId: event.runId }).catch(() => undefined);
        }
        break;
      }
      case "agent_delta":
        await reporter.agentDelta(event.delta, event.messagePhase, event.itemId);
        break;
      case "plan_updated":
        await reporter.planUpdated(event.explanation, event.steps);
        break;
      case "item_started":
        reporter.recordItemStarted(event.item);
        break;
      case "item_completed":
        await reporter.itemCompleted(event.item);
        break;
      case "diff_updated":
        await reporter.diffUpdated(event.changedFiles);
        break;
      case "approval_requested": {
        if (!this.agent.capabilities.approvals || !this.agent.resolveApproval) {
          await reporter.warning();
          await this.messages.sendMarkdown(
            target,
            `${this.agent.metadata.displayName} requested approval, but this driver does not support remote approval resolution.`,
          );
          break;
        }
        const shortId = createShortId();
        const pending: PendingApproval = {
          approvalShortId: shortId,
          userOpenId: claim.userOpenId,
          agentSessionId: event.approval.sessionId,
          runId: event.approval.runId,
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
      case "run_completed":
        await reporter.completed(event.status);
        await this.sessions.completeRun(claim, event.runId);
        break;
      case "warning":
        await reporter.warning();
        break;
      case "error":
        await reporter.fail(event.message);
        await this.messages.sendMarkdown(target, `${this.agent.metadata.displayName} error: ${event.message}`);
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
        [`已收到，已进入 ${projectKey} 的 ${this.agent.metadata.displayName} 处理队列。`, "可用 /status 查看状态，/stop 中止。"].join("\n"),
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
