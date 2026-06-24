import type { CodexItemSummary, CodexPlanStep } from "../codex/types.js";
import type { FeishuMessagePort, ReplyTarget } from "../feishu/types.js";

type CardStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";

export class TurnStatusReporter {
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
