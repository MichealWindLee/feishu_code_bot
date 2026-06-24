import { commandHelp, parseCommand, type BotCommand } from "./commands.js";
import { getProject } from "../config/index.js";
import type { AppConfig } from "../config/types.js";
import type { CodexDriver, CodexEvent, CodexItemSummary, CodexPlanStep } from "../codex/types.js";
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

type CardStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";

class TurnStatusReporter {
  private messageId: string | null = null;
  private status: CardStatus = "queued";
  private current = "等待 Codex 开始处理";
  private activeTurnId: string | null = null;
  private lastTurnStatus = "inProgress";
  private readonly plan: CodexPlanStep[] = [];
  private readonly recentActivities: string[] = [];
  private readonly changedFiles = new Set<string>();
  private agentText = "";
  private commandCount = 0;
  private toolCount = 0;
  private approvalCount = 0;
  private warningCount = 0;

  constructor(
    private readonly messages: FeishuMessagePort,
    private readonly target: ReplyTarget,
    private readonly projectKey: string,
  ) {}

  async start(): Promise<void> {
    await this.createOrUpdateCard();
  }

  async turnStarted(turnId: string): Promise<void> {
    this.status = "running";
    this.activeTurnId = turnId;
    this.current = "Codex 正在处理";
    this.addActivity("任务已开始");
    await this.createOrUpdateCard();
  }

  appendAgentDelta(delta: string): void {
    this.agentText += delta;
  }

  async planUpdated(_explanation: string | null | undefined, steps: CodexPlanStep[]): Promise<void> {
    this.plan.splice(0, this.plan.length, ...steps);
    this.current = "计划已更新";
    await this.createOrUpdateCard();
  }

  async itemStarted(item: CodexItemSummary): Promise<void> {
    this.current = startedText(item);
    this.addActivity(`开始：${itemActivityText(item)}`);
    await this.createOrUpdateCard();
  }

  async itemCompleted(item: CodexItemSummary): Promise<void> {
    if (item.type === "agent_message" && item.text) this.agentText = item.text;
    if (item.type === "command_execution") this.commandCount += 1;
    if (item.type === "mcp_tool_call" || item.type === "dynamic_tool_call") this.toolCount += 1;
    for (const file of item.changedFiles ?? []) this.changedFiles.add(file);

    this.current = completedText(item);
    this.addActivity(`完成：${itemActivityText(item)}`);
    await this.createOrUpdateCard();
  }

  async diffUpdated(changedFiles: string[]): Promise<void> {
    for (const file of changedFiles) this.changedFiles.add(file);
    if (changedFiles.length > 0) {
      this.current = `检测到 ${changedFiles.length} 个文件变更`;
      await this.createOrUpdateCard();
    }
  }

  async approvalRequested(title: string): Promise<void> {
    this.status = "waiting_approval";
    this.current = title;
    this.approvalCount += 1;
    this.addActivity(`等待审批：${title}`);
    await this.createOrUpdateCard();
  }

  async warning(message: string): Promise<void> {
    this.warningCount += 1;
    this.addActivity(`提示：${message}`);
    await this.createOrUpdateCard();
  }

  async completed(status: string): Promise<void> {
    this.lastTurnStatus = status;
    this.status = statusToCardStatus(status);
    this.current = statusToCurrentText(status);
    this.addActivity(this.current);
    await this.createOrUpdateCard();
  }

  async fail(message: string): Promise<void> {
    this.lastTurnStatus = "failed";
    this.status = "failed";
    this.current = message;
    this.addActivity(`失败：${message}`);
    await this.createOrUpdateCard();
  }

  finalText(): string {
    return this.agentText.trim();
  }

  turnStatus(): string {
    return this.lastTurnStatus;
  }

  private addActivity(activity: string): void {
    this.recentActivities.unshift(truncate(activity, 120));
    this.recentActivities.splice(5);
  }

  private async createOrUpdateCard(): Promise<void> {
    const card = renderTurnStatusCard({
      projectKey: this.projectKey,
      status: this.status,
      current: this.current,
      activeTurnId: this.activeTurnId,
      plan: this.plan,
      recentActivities: this.recentActivities,
      changedFiles: [...this.changedFiles],
      commandCount: this.commandCount,
      toolCount: this.toolCount,
      approvalCount: this.approvalCount,
      warningCount: this.warningCount,
    });

    try {
      if (this.messageId) {
        await this.messages.updateCard(this.messageId, card);
      } else {
        const result = await this.messages.sendCard(this.target, card, { replyTo: this.target.messageId });
        this.messageId = result.messageId;
      }
    } catch (error) {
      console.error("Failed to update Codex status card", error);
    }
  }
}

type TurnCardState = {
  projectKey: string;
  status: CardStatus;
  current: string;
  activeTurnId: string | null;
  plan: CodexPlanStep[];
  recentActivities: string[];
  changedFiles: string[];
  commandCount: number;
  toolCount: number;
  approvalCount: number;
  warningCount: number;
};

function renderTurnStatusCard(state: TurnCardState): object {
  const summary = [
    `**状态**：${statusLabel(state.status)}`,
    `**项目**：${state.projectKey}`,
    state.activeTurnId ? `**Turn**：${state.activeTurnId}` : null,
    `**当前**：${truncate(state.current, 160)}`,
    `**活动摘要**：命令 ${state.commandCount} 个，工具 ${state.toolCount} 个，文件 ${state.changedFiles.length} 个，审批 ${state.approvalCount} 个`,
    state.warningCount > 0 ? `**提示**：${state.warningCount} 条` : null,
  ].filter(Boolean).join("\n");

  const elements: object[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: summary },
    },
  ];

  if (state.plan.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: ["**计划**", ...state.plan.slice(0, 8).map((step) => `${planMarker(step.status)} ${truncate(step.step, 120)}`)].join("\n"),
      },
    });
  }

  if (state.changedFiles.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: ["**文件变更**", ...state.changedFiles.slice(0, 8).map((file) => `- ${file}`)].join("\n"),
      },
    });
  }

  if (state.recentActivities.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: ["**最近活动**", ...state.recentActivities.map((activity) => `- ${activity}`)].join("\n"),
      },
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: statusTemplate(state.status),
      title: { tag: "plain_text", content: `Codex ${statusLabel(state.status)}` },
    },
    elements,
  };
}

function startedText(item: CodexItemSummary): string {
  switch (item.type) {
    case "reasoning":
      return "Codex 正在分析";
    case "command_execution":
      return `正在执行命令：${truncate(item.command ?? item.title, 120)}`;
    case "file_change":
      return "正在修改文件";
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return `正在调用工具：${item.toolName ?? item.title}`;
    case "web_search":
      return item.title;
    case "agent_message":
      return "正在生成回复";
    default:
      return item.title;
  }
}

function completedText(item: CodexItemSummary): string {
  if (item.type === "command_execution") {
    const exitText = item.exitCode === null || item.exitCode === undefined ? "" : `，退出码 ${item.exitCode}`;
    return `命令执行完成${exitText}`;
  }
  if (item.type === "file_change") {
    return `文件修改完成：${item.changedFiles?.length ?? 0} 个文件`;
  }
  if (item.type === "agent_message") return "回复已生成";
  return `${itemActivityText(item)} 已完成`;
}

function itemActivityText(item: CodexItemSummary): string {
  if (item.type === "command_execution") return truncate(item.command ?? item.title, 120);
  if (item.type === "file_change") return `${item.changedFiles?.length ?? 0} 个文件变更`;
  return truncate(item.toolName ?? item.title, 120);
}

function statusToCardStatus(status: string): CardStatus {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return "running";
}

function statusToCurrentText(status: string): string {
  if (status === "completed") return "Codex 任务已完成";
  if (status === "interrupted") return "Codex 任务已中止";
  if (status === "failed") return "Codex 任务失败";
  return "Codex 仍在处理";
}

function statusLabel(status: CardStatus): string {
  switch (status) {
    case "queued":
      return "已接收";
    case "running":
      return "执行中";
    case "waiting_approval":
      return "等待审批";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "interrupted":
      return "已中止";
  }
}

function statusTemplate(status: CardStatus): string {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "interrupted":
      return "grey";
    case "waiting_approval":
      return "orange";
    case "queued":
    case "running":
      return "blue";
  }
}

function planMarker(status: CodexPlanStep["status"]): string {
  if (status === "completed") return "[x]";
  if (status === "inProgress") return "[-]";
  return "[ ]";
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}
