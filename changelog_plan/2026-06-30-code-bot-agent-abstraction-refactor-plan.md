# Code Agent Driver 架构整理方案

## Summary

- 将当前 `BotService -> CodexDriver -> CodexAppServerDriver` 整理为 `BotService -> CodeAgentDriver -> Codex/Claude/Trae adapters`。
- 第一阶段采用 **单服务实例绑定单 Agent**：不同 Feishu 机器人用不同 config/进程运行，不在 BotService 内做多 agent 路由。
- 采用 **Session 核心 + 可选恢复/可选能力**：BotService 统一管理 `agentSessionId`、active run、approval、`/new`、`/end`、`/stop`；driver 用 capabilities 声明是否支持 resume、interrupt、approval、plan、diff 等能力。
- SQLite 状态允许清空/破坏兼容，不做复杂旧数据迁移；但配置层尽量保留旧 `codex` 配置兼容，降低本地启动成本。

## Key Changes

- 新增中性 agent 协议模块，例如 `src/agent/types.ts`：
  - `CodeAgentDriver`
  - `AgentSession`
  - `AgentRunEvent`
  - `AgentApprovalRequest`
  - `AgentCapabilities`
  - `AgentRunStatus`
- 将现有 `src/codex/types.ts` 的公共契约迁移为中性类型；`src/codex/*` 只保留 Codex app-server adapter 与事件转换逻辑。
- `SessionManager` 改为依赖 `CodeAgentDriver`，持久化字段从 `codexThreadId` 语义改为 `agentSessionId`，运行态从 `threadId/turnId` 改为 `sessionId/runId`。
- `BotService` 和 `BotCommandHandler` 不再 import Codex 类型，不再写 Codex 专属分支；只读取 `driver.metadata.displayName` 和 `driver.capabilities`。
- `TurnStatusReporter` 改成中性 agent reporter：
  - 卡片标题和文案使用 driver display name。
  - 不支持 plan/diff 的 agent 不展示对应区域。
  - final/commentary/message delta 仍按统一事件消费。
- `/new`、`/end`、`/stop` 保持为 BotService 层产品语义：
  - `/new`：停止当前 run，清理旧上下文，创建 fresh agent session。
  - `/end`：清理当前用户 session binding 和 pending approvals，必要时 best-effort dispose。
  - `/stop`：如果 `interruptRun` 支持则调用，否则返回该 agent 不支持停止当前任务。
- 配置新增中性 `agent`：
  - 首版支持 `{ "type": "codex", "displayName": "Codex", ... }`。
  - 旧 `codex` 配置可在 loader 中归一化为 Codex agent config。
  - `projects` 暂不负责 agent 路由，只保留 path/model/sandbox/approvalPolicy 这类项目参数。

## Public Interfaces

- `CodeAgentDriver` 必须实现：
  - `metadata`
  - `capabilities`
  - `start()`
  - `stop()`
  - `createSession(input)`
  - `startRun(input)`
- `CodeAgentDriver` 可选实现：
  - `resumeSession(input)`
  - `disposeSession(input)`
  - `interruptRun(input)`
  - `resolveApproval(input)`
- 所有 driver 请求和事件类型保持 JSON-serializable，未来可以平滑搬到 out-of-process gateway。
- Codex adapter 继续使用 `codex app-server`，但只在 adapter 内部保留 JSON-RPC、thread/turn、raw approval payload 等 Codex 协议细节。

## Test Plan

- 更新现有 BotService 测试，使用 `FakeCodeAgentDriver` 验证主 prompt 流程、状态卡、approval、busy blocking、`/new`、`/end`、`/stop`。
- 增加 capability 降级测试：
  - 不支持 interrupt 时 `/stop` 返回明确提示。
  - 不支持 approval 时不会注册 `/approve` pending flow。
  - 不支持 resume 的 session 在启动恢复时不尝试 resume。
- 保留 Codex app-server adapter 测试，验证 JSON-RPC 事件仍正确转换为中性 `AgentRunEvent`。
- 更新 config 测试，覆盖新 `agent` 配置和旧 `codex` 配置兼容归一化。
- 跑 `pnpm typecheck` 和 `pnpm test`。

## Assumptions

- 第一阶段不实现 Claude Code/Trae CLI adapter，只把 Codex 改造成第一个 `CodeAgentDriver` 实现。
- 第一阶段不实现 out-of-process gateway，但协议类型按未来 gateway 可复用的纯对象设计。
- 第一阶段不做单服务多 agent routing；多个 Feishu 机器人通过多个 config/进程运行。
- SQLite 旧状态可以清空或被 schema 重建，不需要迁移现有 `codexThreadId` 数据。
- 用户可见文案同步中性化，使用具体 agent display name 替代硬编码 Codex。
