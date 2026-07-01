import type { AgentCapabilities, AgentItemSummary, AgentMessagePhase, AgentPlanStep } from "../agent/types.js";
import type { FeishuMessagePort, ReplyTarget } from "../feishu/types.js";

type RunCardStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";

const PROGRESS_UPDATE_INTERVAL_MS = 20_000;
const MIN_PROGRESS_DELTA_LENGTH = 40;

export class RunStatusReporter {
  private messageId: string | null = null;
  private status: RunCardStatus = "queued";
  private current: string;
  private lastRunStatus = "inProgress";
  private readonly plan: AgentPlanStep[] = [];
  private readonly changedFiles = new Set<string>();
  private progressText = "";
  private progressDraft = "";
  private progressItemId: string | null = null;
  private lastProgressCardAt = 0;
  private agentText = "";
  private commandCount = 0;
  private toolCount = 0;
  private approvalCount = 0;
  private warningCount = 0;

  constructor(
    private readonly messages: FeishuMessagePort,
    private readonly target: ReplyTarget,
    private readonly projectKey: string,
    private readonly agentDisplayName: string,
    private readonly capabilities: AgentCapabilities,
  ) {
    this.current = `等待 ${this.agentDisplayName} 开始处理`;
  }

  async start(): Promise<void> {
    await this.createOrUpdateCard();
  }

  async runStarted(): Promise<void> {
    this.status = "running";
    this.current = `${this.agentDisplayName} 正在处理`;
    await this.createOrUpdateCard();
  }

  async agentDelta(delta: string, messagePhase?: AgentMessagePhase | null, itemId?: string): Promise<void> {
    if (messagePhase === "commentary") {
      if (itemId && this.progressItemId !== itemId) {
        this.progressItemId = itemId;
        this.progressDraft = "";
      }
      this.progressDraft += delta;
      await this.flushProgressDraft(false);
      return;
    }
    this.agentText += delta;
  }

  async planUpdated(_explanation: string | null | undefined, steps: AgentPlanStep[]): Promise<void> {
    if (!this.capabilities.planUpdates) return;
    this.plan.splice(0, this.plan.length, ...steps);
    await this.createOrUpdateCard();
  }

  recordItemStarted(item: AgentItemSummary): void {
    if (item.type === "agent_message" && item.messagePhase === "commentary") {
      if (this.progressItemId !== item.id) {
        this.progressItemId = item.id;
        this.progressDraft = item.text ?? "";
      } else if (!this.progressDraft && item.text) {
        this.progressDraft = item.text;
      }
    }
  }

  async itemCompleted(item: AgentItemSummary): Promise<void> {
    if (item.type === "agent_message" && item.text) {
      if (item.messagePhase === "commentary") {
        this.progressItemId = item.id;
        this.progressDraft = item.text;
        await this.flushProgressDraft(true);
      } else {
        this.agentText = item.text;
      }
    }
    if (item.type === "command_execution") this.commandCount += 1;
    if (item.type === "mcp_tool_call" || item.type === "dynamic_tool_call") this.toolCount += 1;
    if (this.capabilities.fileDiffs) {
      for (const file of item.changedFiles ?? []) this.changedFiles.add(file);
    }
  }

  async diffUpdated(changedFiles: string[]): Promise<void> {
    if (!this.capabilities.fileDiffs) return;
    const before = this.changedFiles.size;
    for (const file of changedFiles) {
      this.changedFiles.add(file);
    }
    const addedCount = this.changedFiles.size - before;
    if (addedCount > 0) {
      this.current = `检测到 ${addedCount} 个文件变更`;
      await this.createOrUpdateCard();
    }
  }

  async approvalRequested(title: string): Promise<void> {
    this.status = "waiting_approval";
    this.current = title;
    this.approvalCount += 1;
    await this.createOrUpdateCard();
  }

  async warning(): Promise<void> {
    this.warningCount += 1;
    this.current = `${this.agentDisplayName} 返回提示`;
    await this.createOrUpdateCard();
  }

  async completed(status: string): Promise<void> {
    this.lastRunStatus = status;
    this.status = statusToCardStatus(status);
    this.current = statusToCurrentText(status);
    await this.createOrUpdateCard();
  }

  async fail(message: string): Promise<void> {
    this.lastRunStatus = "failed";
    this.status = "failed";
    this.current = message;
    await this.createOrUpdateCard();
  }

  finalText(): string {
    return this.agentText.trim();
  }

  runStatus(): string {
    return this.lastRunStatus;
  }

  private async createOrUpdateCard(): Promise<void> {
    const card = renderRunStatusCard({
      agentDisplayName: this.agentDisplayName,
      projectKey: this.projectKey,
      status: this.status,
      current: this.current,
      progressText: this.progressText,
      plan: this.plan,
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
      console.error("Failed to update agent status card", error);
    }
  }

  private async flushProgressDraft(force: boolean): Promise<void> {
    const text = normalizeProgressText(this.progressDraft);
    if (!text) return;
    if (!force && text.length < MIN_PROGRESS_DELTA_LENGTH && !endsWithSentenceBoundary(text)) return;
    await this.updateProgress(text, force);
  }

  private async updateProgress(text: string, force: boolean): Promise<void> {
    const progress = normalizeProgressText(text);
    if (!progress || progress === this.progressText) return;

    const now = Date.now();
    if (!force && this.lastProgressCardAt > 0 && now - this.lastProgressCardAt < PROGRESS_UPDATE_INTERVAL_MS) {
      return;
    }

    this.progressText = progress;
    if (this.status === "queued") this.status = "running";
    if (this.current === `等待 ${this.agentDisplayName} 开始处理`) this.current = `${this.agentDisplayName} 正在处理`;
    this.lastProgressCardAt = now;
    await this.createOrUpdateCard();
  }
}

type RunCardState = {
  agentDisplayName: string;
  projectKey: string;
  status: RunCardStatus;
  current: string;
  progressText: string;
  plan: AgentPlanStep[];
  changedFiles: string[];
  commandCount: number;
  toolCount: number;
  approvalCount: number;
  warningCount: number;
};

function renderRunStatusCard(state: RunCardState): object {
  const summary = [
    `**状态**：${statusLabel(state.status)}`,
    `**项目**：${state.projectKey}`,
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

  if (state.progressText) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: ["**阶段反馈**", truncate(state.progressText, 280)].join("\n"),
      },
    });
  }

  if (state.plan.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          "**计划**",
          ...state.plan.slice(0, 8).map((step) => `${planMarker(step.status)} ${truncate(step.step, 120)}`),
        ].join("\n"),
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

  return {
    config: { wide_screen_mode: true },
    header: {
      template: statusTemplate(state.status),
      title: { tag: "plain_text", content: `${state.agentDisplayName} ${statusLabel(state.status)}` },
    },
    elements,
  };
}

function statusToCardStatus(status: string): RunCardStatus {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return "running";
}

function statusToCurrentText(status: string): string {
  if (status === "completed") return "任务已完成";
  if (status === "interrupted") return "任务已中止";
  if (status === "failed") return "任务失败";
  return "仍在处理";
}

function statusLabel(status: RunCardStatus): string {
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

function statusTemplate(status: RunCardStatus): string {
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

function planMarker(status: AgentPlanStep["status"]): string {
  if (status === "completed") return "[x]";
  if (status === "inProgress") return "[-]";
  return "[ ]";
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function normalizeProgressText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function endsWithSentenceBoundary(text: string): boolean {
  return /[。！？.!?]$/.test(text);
}
