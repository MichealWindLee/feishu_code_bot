import type { ProjectConfig } from "../config/types.js";

/**
 * Code agent 的中性协议层。
 *
 * BotService 只依赖这里的 session/run/approval/event 语义，不感知 Codex
 * thread/turn、Claude/Trea CLI 进程协议、JSON-RPC payload 等具体实现细节。
 * 这里的输入、输出和 event 应保持为 JSON-serializable 的普通对象，方便未来
 * 把 driver 挪到独立进程或 gateway 后继续复用协议。
 */

export interface AgentMetadata {
  /** Driver 定义的稳定标识，用于日志、指标和排障；不要求由用户配置提供。 */
  id: string;
  /** 用户可见名称，用于飞书卡片、命令反馈等文案，例如 Codex / Claude Code。 */
  displayName: string;
}

export interface AgentCapabilities {
  /**
   * 是否能通过已有 sessionId 恢复上下文。
   * BotService 会据此决定启动恢复时是否调用 resumeSession。
   */
  resumeSession: boolean;
  /**
   * 是否支持中断正在执行的 run。
   * BotService 会据此决定 /stop 是调用 interruptRun，还是返回不支持提示。
   */
  interruptRun: boolean;
  /**
   * 是否可能在 run 中发起用户审批。
   * false 时 driver 不应发出 approval_requested，BotService 也不会注册审批流。
   */
  approvals: boolean;
  /** 是否会产出 plan_updated 事件；不支持时状态卡不展示 plan 区域。 */
  planUpdates: boolean;
  /** 是否会产出 diff_updated 事件；不支持时状态卡不展示 diff 区域。 */
  fileDiffs: boolean;
  /** 是否可能在 run 中向用户发起澄清问题。 */
  userInputRequests?: boolean;
  /**
   * 是否支持进程级控制能力，例如强制 kill agent 子进程。
   * 这不是主 session/run 协议的必需能力，保留给 /kill 这类运维命令判断。
   */
  processControl?: boolean;
}

export interface AgentSession {
  /** Driver 内部定义的不透明 session id，BotService 只负责保存和回传。 */
  id: string;
  /**
   * 当前 session 是否可跨进程重启后恢复。
   * 这允许 driver 具备全局 resume 能力，但对某些临时 session 返回 false。
   */
  resumeSupported: boolean;
}

export interface CreateAgentSessionInput {
  /** 本次会话绑定的项目参数，包含工作目录、模型、沙箱和审批策略等。 */
  project: ProjectConfig;
}

export interface ResumeAgentSessionInput extends CreateAgentSessionInput {
  /** 之前由 createSession/resumeSession 返回并持久化的 session id。 */
  sessionId: string;
}

export interface DisposeAgentSessionInput {
  /** 需要释放的 driver session id。 */
  sessionId: string;
  /** session 所属项目参数，供 driver 定位工作目录或后端资源。 */
  project: ProjectConfig;
}

export interface StartAgentRunInput {
  /** run 所属的 agent session id。 */
  sessionId: string;
  /** 本次 run 使用的项目参数，允许 driver 按项目覆盖模型、沙箱或审批策略。 */
  project: ProjectConfig;
  /** 用户输入给 agent 的文本内容。 */
  text: string;
  /**
   * 飞书侧用户消息 id，用于日志、排障或幂等；没有对应概念的 driver 可以忽略。
   */
  clientUserMessageId?: string;
}

export interface InterruptAgentRunInput {
  /** run 所属的 agent session id。 */
  sessionId: string;
  /** 需要中断的 run id。 */
  runId: string;
}

export type AgentApprovalKind = "command" | "file_change" | "permissions" | "legacy_exec" | "legacy_apply_patch";

export interface AgentApprovalRequest {
  /** 审批类型，用于 BotService 选择用户文案和后续 resolve 语义。 */
  kind: AgentApprovalKind;
  /** Driver 原始审批请求 id；BotService 原样回传给 resolveApproval。 */
  requestId: string | number;
  /** 审批所属的 session id。 */
  sessionId: string;
  /** 审批所属的 run id。 */
  runId: string;
  /** 可选的输出 item id，用于把审批挂到某个工具调用或文件变更上。 */
  itemId?: string;
  /** 用户可见的审批标题。 */
  title: string;
  /** 用户可见的审批详情正文。 */
  body: string;
  /**
   * Driver 私有的审批 payload，resolveApproval 时会原样传回。
   * 实现时仍应保持 JSON-serializable，避免未来跨进程传输时失真。
   */
  raw: unknown;
}

export type AgentPlanStepStatus = "pending" | "inProgress" | "completed";
export type AgentMessagePhase = "commentary" | "final_answer";
export type AgentRunStatus = "inProgress" | "completed" | "interrupted" | "failed" | string;

export interface AgentPlanStep {
  /** 单个 plan step 的用户可见描述。 */
  step: string;
  /** 单个 plan step 的当前状态。 */
  status: AgentPlanStepStatus;
}

export type AgentItemType =
  | "agent_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "web_search"
  | "image_generation"
  | "user_message"
  | "other";

export interface AgentItemSummary {
  /** Driver 定义的输出 item id，同一 run 内应稳定。 */
  id: string;
  /** 归一化后的 item 类型，用于状态卡选择展示方式。 */
  type: AgentItemType;
  /** 用户可见标题，例如命令、工具名、文件变更摘要等。 */
  title: string;
  /** Driver 原始或归一化状态；BotService 不依赖具体枚举做核心控制。 */
  status?: string;
  /** agent_message 的阶段，用来区分过程输出和最终回答。 */
  messagePhase?: AgentMessagePhase | null;
  /** item 的文本摘要，适合展示在状态卡里。 */
  text?: string;
  /** 命令执行类 item 的命令文本。 */
  command?: string;
  /** 命令执行类 item 的工作目录。 */
  cwd?: string;
  /** 命令执行类 item 的退出码；未知或尚未结束时可以为空。 */
  exitCode?: number | null;
  /** item 执行耗时；未知或尚未结束时可以为空。 */
  durationMs?: number | null;
  /** 文件变更类 item 影响的文件路径列表。 */
  changedFiles?: string[];
  /** MCP/dynamic tool 类 item 的工具名。 */
  toolName?: string;
}

/**
 * 单次 agent run 的事件流。
 *
 * startRun 返回的 AsyncIterable 应在 run 结束时自然结束；若底层协议异常，可以
 * 抛错或产出 error 事件后结束。run_started 应尽早发出，方便 BotService 建立
 * active run；plan/diff/approval 事件只应在对应 capability 为 true 时出现。
 */
export type AgentRunEvent =
  /** Driver 已拿到真实 run id；BotService 从这里开始持久化 active run。 */
  | { type: "run_started"; sessionId: string; runId: string }
  /** Agent 文本增量，commentary 用于过程卡片，final_answer 用于最终回复聚合。 */
  | {
      type: "agent_delta";
      sessionId: string;
      runId: string;
      delta: string;
      itemId?: string;
      messagePhase?: AgentMessagePhase | null;
    }
  /** Agent 计划更新；仅当 capabilities.planUpdates 为 true 时使用。 */
  | { type: "plan_updated"; sessionId: string; runId: string; explanation?: string | null; steps: AgentPlanStep[] }
  /** 一个工具调用、推理块、文件变更等输出 item 开始。 */
  | { type: "item_started"; sessionId: string; runId: string; item: AgentItemSummary }
  /** 一个输出 item 完成或进入稳定状态。 */
  | { type: "item_completed"; sessionId: string; runId: string; item: AgentItemSummary }
  /** 文件 diff 更新；仅当 capabilities.fileDiffs 为 true 时使用。 */
  | { type: "diff_updated"; sessionId: string; runId: string; diff: string; changedFiles: string[] }
  /** Agent 请求用户审批；仅当 capabilities.approvals 为 true 时使用。 */
  | { type: "approval_requested"; approval: AgentApprovalRequest }
  /** Agent 请求用户回答澄清问题；仅当 capabilities.userInputRequests 为 true 时使用。 */
  | { type: "user_input_requested"; request: AgentUserInputRequest }
  /** run 进入终态。发出该事件后，事件流通常应尽快结束。 */
  | { type: "run_completed"; sessionId: string; runId: string; status: AgentRunStatus }
  /** 非致命告警，可关联到 session，也可作为全局 driver 告警。 */
  | { type: "warning"; sessionId?: string; message: string }
  /** 错误事件，可关联到 session/run；严重错误也可以通过 startRun 抛出。 */
  | { type: "error"; sessionId?: string; runId?: string; message: string };

export interface ResolveAgentApprovalInput {
  /** 要处理的审批类型，应与 approval_requested 中的 kind 一致。 */
  kind: AgentApprovalKind;
  /** 要处理的原始审批请求 id。 */
  requestId: string | number;
  /** true 表示批准，false 表示拒绝。 */
  approved: boolean;
  /** approval_requested.raw 的原样回传，供 driver 调用底层协议。 */
  raw: unknown;
}

export interface AgentUserInputOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AgentUserInputQuestion {
  question: string;
  header: string;
  options: AgentUserInputOption[];
  multiSelect?: boolean;
}

export interface AgentUserInputRequest {
  /** Driver 原始请求 id；BotService 原样回传给 resolveUserInput。 */
  requestId: string | number;
  /** 提问所属的 session id。 */
  sessionId: string;
  /** 提问所属的 run id。 */
  runId: string;
  /** 用户可见标题。 */
  title: string;
  /** 用户可见正文说明。 */
  body: string;
  /** Agent 需要用户回答的问题列表。 */
  questions: AgentUserInputQuestion[];
  /** Driver 私有 payload，resolveUserInput 时原样传回。 */
  raw: unknown;
}

export interface AgentUserInputResponse {
  answers: Record<string, string | string[]>;
}

export interface ResolveAgentUserInputInput {
  requestId: string | number;
  response: AgentUserInputResponse;
  raw: unknown;
}

export interface CodeAgentDriver {
  /** Driver 元信息。BotService 用 displayName 生成用户可见文案。 */
  metadata: AgentMetadata;
  /** Driver 能力声明。BotService 依赖它做命令降级和状态卡展示。 */
  capabilities: AgentCapabilities;
  /**
   * 启动 driver 依赖的底层资源，例如子进程、RPC client 或本地 daemon 连接。
   * 应设计为幂等；BotService 启动阶段会调用一次，测试或重连场景可能重复调用。
   */
  start(): Promise<void>;
  /**
   * 停止 driver 资源。
   * 应尽量释放子进程、socket 和 pending 请求；多次调用应安全返回。
   */
  stop(): Promise<void>;
  /**
   * 创建一个全新的 agent session。
   * 用于用户首次发消息、/new 重置上下文等场景。实现应返回不透明 id，不要泄漏
   * BotService 需要理解的底层协议概念。
   */
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;
  /**
   * 恢复一个已持久化的 agent session。
   * 仅当 capabilities.resumeSession 为 true 时实现和调用。若底层发现 session
   * 已失效，应抛出错误，让 BotService 回退到创建新 session 或提示用户。
   */
  resumeSession?(input: ResumeAgentSessionInput): Promise<AgentSession>;
  /**
   * 释放一个不再绑定用户的 agent session。
   * 用于 /end、/new 替换旧上下文或清理孤儿 session。它是 best-effort 的资源
   * 回收钩子，不应要求所有 driver 都实现；不支持显式释放的 agent 可以省略。
   */
  disposeSession?(input: DisposeAgentSessionInput): Promise<void>;
  /**
   * 在指定 session 中启动一次用户请求。
   * 返回的事件流必须只描述本次 run；拿到真实 runId 后应先发 run_started，再
   * 继续发 delta/item/approval/diff 等事件，最后以 run_completed 或错误结束。
   */
  startRun(input: StartAgentRunInput): AsyncIterable<AgentRunEvent>;
  /**
   * 中断正在执行的 run。
   * 仅当 capabilities.interruptRun 为 true 时实现和调用。实现可以映射到底层的
   * interrupt API、Ctrl-C 或其它取消机制，但应尽量只影响目标 run。
   */
  interruptRun?(input: InterruptAgentRunInput): Promise<void>;
  /**
   * 响应 agent 发起的审批请求。
   * 仅当 capabilities.approvals 为 true 时实现和调用。实现应使用 requestId/raw
   * 调用底层协议，并把 approved 映射为具体 agent 的允许/拒绝语义。
   */
  resolveApproval?(input: ResolveAgentApprovalInput): Promise<void>;
  /**
   * 响应 agent 发起的用户澄清问题。
   * 仅当 capabilities.userInputRequests 为 true 时实现和调用。
   */
  resolveUserInput?(input: ResolveAgentUserInputInput): Promise<void>;
}
