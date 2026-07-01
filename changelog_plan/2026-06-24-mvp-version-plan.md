# Feishu Codex Bot MVP Plan

## Summary
构建一个 Node.js/TypeScript 云端服务：飞书 Bot 通过长连接接收用户消息和交互事件，服务端通过 `codex app-server` 驱动 Codex，并把 Codex 输出、审批请求、任务状态回传到飞书。

核心决策：
- 飞书入口使用 `WSClient + EventDispatcher`，不使用 Webhook，不默认使用 Channel。
- Codex 入口使用 `codex app-server --listen stdio://` 最小协议子集，不走 PTY，不以 `@openai/codex-sdk` 作为主路径。
- 每个 Feishu 用户只有一个当前 Codex session；`/new` 会中止旧任务并创建新 session。
- 项目路径来自静态 allowlist；不允许用户输入任意本地路径。
- 服务重启后恢复 Codex thread 历史；第一版不保证接管仍在执行中的 turn。
- 普通消息使用 `turn/start`；第一版不自动使用 `turn/steer`。
- 审批用命令：`/approve <id>`、`/deny <id>`。

## Key Interfaces
飞书侧拆成事件入口、消息输出、Bot 管理，业务层不依赖 SDK 原始事件：

```ts
interface FeishuGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (event: FeishuInboundEvent) => void | Promise<void>): void;
}

type FeishuInboundEvent =
  | FeishuMessageEvent
  | FeishuCardActionEvent
  | FeishuBotMenuEvent
  | FeishuReactionEvent
  | FeishuConnectionEvent;

interface FeishuMessagePort {
  sendMarkdown(target: ReplyTarget, markdown: string, opts?: SendOptions): Promise<SendResult>;
  streamMarkdown(target: ReplyTarget, stream: AsyncIterable<string>, opts?: SendOptions): Promise<SendResult>;
  sendCard(target: ReplyTarget, card: object, opts?: SendOptions): Promise<SendResult>;
  updateCard(messageId: string, card: object): Promise<void>;
}

interface FeishuBotAdminPort {
  getChatInfo(chatId: string): Promise<ChatInfo>;
  upsertChatMenu(chatId: string, menu: ChatMenuSpec): Promise<void>;
}
```

Codex 侧只暴露 MVP 必需能力：

```ts
interface CodexDriver {
  startThread(input: StartThreadInput): Promise<CodexThread>;
  resumeThread(threadId: string, input: ResumeThreadInput): Promise<CodexThread>;
  startTurn(input: StartTurnInput): AsyncIterable<CodexEvent>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  resolveApproval(input: ResolveApprovalInput): Promise<void>;
}
```

## Implementation Changes
- 工程基础：`pnpm`、Node.js 20+、TypeScript、`tsx`、`tsup`、Vitest、SQLite。
- 配置：飞书 appId/appSecret、允许用户、允许群、静态 projects、Codex binary path、SQLite path、默认 sandbox 和 approval policy。
- 飞书 Gateway：注册 `im.message.receive_v1`、`card.action.trigger`、`application.bot.menu_v6`，统一转换为 `FeishuInboundEvent`；handler 只做归一化、去重、入队。
- 路由：私聊直接响应；群聊只有 @Bot 才进入；普通文本进入 Codex；命令、卡片点击、菜单点击进入同一 action router。
- 命令：`/help`、`/projects`、`/use <project>`、`/new`、`/status`、`/stop`、`/permissions`、`/approve <id>`、`/deny <id>`。
- Session：`user_open_id` 是第一版 session key；未来如需按“用户+聊天”隔离，升级为 `scope_type + scope_id`。
- Codex app-server：服务启动时托管 stdio 子进程并 initialize；使用 `thread/start|resume`、`turn/start`、`turn/interrupt`、approval request/response、agent delta、turn completed。
- Active turn：同一用户已有 active turn 时，新普通消息提示“任务执行中，请等待或 /stop”，不自动 `turn/steer`。

## Minimal Persistence
第一版 SQLite 保持极简：

```text
current_sessions
- user_open_id primary key
- project_key
- codex_thread_id
- active_turn_id nullable
- last_chat_id
- updated_at

pending_approvals
- approval_short_id primary key
- user_open_id
- codex_thread_id
- turn_id
- request_id
- expires_at

event_dedup
- event_id primary key
- expires_at
```

重启恢复语义：
- 用 `codex_thread_id` 恢复历史 thread。
- 若 `active_turn_id` 残留，标记为 unknown/interrupted，并提示用户上一轮可能中断。
- pending approvals 过期或无法匹配时拒绝执行。

## Test Plan
- Unit：命令解析、项目 allowlist、用户/群权限、群聊 @Bot gating、session key、`/new` 覆盖旧 session、active turn 拦截。
- Feishu adapter：fixture 覆盖消息、卡片点击、Bot 菜单点击到统一事件的转换。
- Codex adapter：fake app-server 验证 initialize、thread start/resume、turn start、interrupt、approval、stream notification demux。
- Persistence：重启后恢复 `codex_thread_id`；pending approval 超时；event dedup TTL。
- Integration：fake Feishu + fake Codex 跑通 `/projects -> /use -> prompt -> stream -> complete`、`/new`、`/stop`、审批 accept/deny、卡片 action、Bot 菜单 event。
- Manual smoke：真实飞书 Bot 验证私聊、群 @Bot、项目切换、Codex 输出、审批命令、服务重启后继续同一 thread。

## Assumptions
- 第一版单实例部署；不做 Redis/Postgres、多实例锁和 HA。
- 服务端 Codex 已预先登录，使用同一个 `CODEX_HOME`。
- 默认权限建议 `workspace-write + on-request`，不默认启用 `danger-full-access`。
- 文本输入优先；图片/文件先记录并提示暂不支持，事件结构保留 resources 字段。
- 不做 Webhook、不做动态项目注册、不做多并行 session、不自动使用 `turn/steer`。
