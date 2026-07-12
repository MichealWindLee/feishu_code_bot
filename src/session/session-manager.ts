import { getProject } from "../config/index.js";
import type { AppConfig, ProjectConfig } from "../config/types.js";
import type { AgentSession, CodeAgentDriver } from "../agent/types.js";
import type { CurrentSession, StateStore } from "../store/types.js";
import { InMemorySessionRuntime, type ActiveRun, type SessionRuntime, type SessionStatus } from "./session-runtime.js";

export type { ActiveRun, SessionStatus } from "./session-runtime.js";

export type SessionSnapshot = {
  userOpenId: string;
  session: CurrentSession | null;
  status: SessionStatus;
  activeRun?: ActiveRun;
};

export type PromptClaim = {
  claimId: string;
  userOpenId: string;
  chatId: string;
  session: CurrentSession;
  project: ProjectConfig;
};

export type BeginPromptResult =
  | { ok: true; claim: PromptClaim }
  | { ok: false; reason: "busy"; status: SessionStatus }
  | { ok: false; reason: "missing_project"; projectKey: string };

export type EnsureAgentSessionResult =
  | { ok: true; agentSession: AgentSession }
  | { ok: false; reason: "stopped" };

export type StopRunResult =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "unsupported" }
  | { status: "none" };

export type EndSessionResult =
  | { status: "ended" }
  | { status: "none" };

export type NewSessionResult =
  | { status: "started"; projectKey: string }
  | { status: "missing_project"; projectKey: string };

export type SwitchProjectResult =
  | { status: "switched"; projectKey: string; projectName: string }
  | { status: "unknown_project"; projectKey: string }
  | { status: "busy"; currentStatus: SessionStatus };

export class SessionManager {
  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly agent: CodeAgentDriver,
    private readonly runtime: SessionRuntime = new InMemorySessionRuntime(),
  ) {}

  async getSnapshot(userOpenId: string): Promise<SessionSnapshot> {
    return this.withUserLock(userOpenId, async () => {
      const session = await this.store.getCurrentSession(userOpenId);
      return this.snapshotFrom(userOpenId, session);
    });
  }

  async ensureSession(userOpenId: string, chatId: string): Promise<CurrentSession> {
    return this.withUserLock(userOpenId, () => this.ensureSessionUnlocked(userOpenId, chatId));
  }

  async beginPrompt(userOpenId: string, chatId: string): Promise<BeginPromptResult> {
    return this.withUserLock(userOpenId, async () => {
      const session = await this.ensureSessionUnlocked(userOpenId, chatId);
      const snapshot = this.snapshotFrom(userOpenId, session);
      if (snapshot.status !== "idle") return { ok: false, reason: "busy", status: snapshot.status };

      const project = getProject(this.config, session.projectKey);
      if (!project) return { ok: false, reason: "missing_project", projectKey: session.projectKey };

      const claim: PromptClaim = {
        claimId: this.runtime.nextClaimId(),
        userOpenId,
        chatId,
        session,
        project,
      };
      // 先同步占住 starting_run，再让 BotService 异步启动 agent run。
      // 这样 /end 或第二条 prompt 不会在 startRun 尚未返回 runId 时误判为空闲。
      this.runtime.setSessionState(userOpenId, {
        status: "starting_run",
        claimId: claim.claimId,
        stopRequested: false,
      });
      return { ok: true, claim };
    });
  }

  runPromptTask(claim: PromptClaim, run: () => Promise<void>): Promise<void> {
    const task = Promise.resolve()
      .then(run)
      .finally(() => this.finishPrompt(claim));
    const runtime = this.runtime.getSessionState(claim.userOpenId);
    // runTask 让 /end、/new、waitForIdle 可以等待当前 prompt 的异步主流程收尾。
    if (runtime?.claimId === claim.claimId) runtime.runTask = task;
    return task;
  }

  async waitForIdle(): Promise<void> {
    // drain 语义：等待一批 runTask 结束后，收尾逻辑可能又注册了新的任务或状态，
    // 所以需要重新取快照，直到 runtime 中确实没有仍在执行的 runTask。
    let tasks = this.activeRunTasks();
    while (tasks.length > 0) {
      await Promise.allSettled(tasks);
      tasks = this.activeRunTasks();
    }
  }

  async ensureAgentSession(claim: PromptClaim): Promise<EnsureAgentSessionResult> {
    if (await this.isStopRequested(claim)) return { ok: false, reason: "stopped" };

    // create/resume session 可能比较慢，不能长时间持有用户锁；否则 /stop 或 /end 会被卡住。
    // 因此这里先执行 agent 调用，回来后再用 claimId + stopRequested 复核状态是否仍有效。
    const agentSession = await this.openAgentSession(claim);

    return this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.getSessionState(claim.userOpenId);
      // 用户可能在 create/resume 期间发了 /stop、/end 或 /new；旧 claim 不允许继续写 session。
      if (runtime?.claimId !== claim.claimId || runtime.stopRequested) {
        return { ok: false, reason: "stopped" };
      }

      this.runtime.markSessionLoaded(agentSession.id);
      if (claim.session.agentSessionId !== agentSession.id) {
        const session = await this.ensureSessionUnlocked(claim.userOpenId, claim.chatId);
        await this.store.upsertCurrentSession({
          ...session,
          agentSessionId: agentSession.id,
          activeRunId: null,
          updatedAt: Date.now(),
        });
        claim.session = { ...session, agentSessionId: agentSession.id, activeRunId: null, updatedAt: Date.now() };
      }
      return { ok: true, agentSession };
    });
  }

  async markRunStarted(claim: PromptClaim, sessionId: string, runId: string): Promise<{ shouldInterrupt: boolean }> {
    return this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.getSessionState(claim.userOpenId);
      // run_started 到达时，如果当前 claim 已经不是最新 claim，说明这是旧异步任务的回调。
      // 此时不能写入当前 session，但现在已经拿到 runId，调用方可以在支持时中止这个过期 run。
      if (runtime?.claimId !== claim.claimId) return { shouldInterrupt: true };

      const activeRun = { sessionId, runId };
      runtime.activeRun = activeRun;
      runtime.status = runtime.stopRequested ? "stopping_run" : "running_run";
      const session = await this.ensureSessionUnlocked(claim.userOpenId, claim.chatId);
      await this.store.upsertCurrentSession({
        ...session,
        agentSessionId: sessionId,
        activeRunId: runId,
        updatedAt: Date.now(),
      });
      // /stop、/end、/new 可能发生在 startRun 发出之后、run_started 返回之前。
      // 那个窗口里还没有 runId，不能真正 interrupt；这里拿到 runId 后补发 interrupt。
      return { shouldInterrupt: runtime.stopRequested };
    });
  }

  async completeRun(claim: PromptClaim, runId: string): Promise<void> {
    await this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.getSessionState(claim.userOpenId);
      // 旧 run 的 completed/error 不允许清理新 claim 的 activeRun。
      if (runtime?.claimId !== claim.claimId) return;
      if (runtime.activeRun?.runId === runId) runtime.activeRun = undefined;
      await this.store.clearActiveRun(claim.userOpenId, runId);
    });
  }

  async failRun(claim: PromptClaim, runId?: string): Promise<void> {
    await this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.getSessionState(claim.userOpenId);
      // 与 completeRun 一样，只有当前 claim 才能清理当前 session 的 run 状态。
      if (runtime?.claimId !== claim.claimId) return;
      runtime.activeRun = undefined;
      await this.store.clearActiveRun(claim.userOpenId, runId);
    });
  }

  async isStopRequested(claim: PromptClaim): Promise<boolean> {
    return this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.getSessionState(claim.userOpenId);
      // claim 失效时，对调用方等价于“请停止”；这样旧异步流程会自然退出。
      return runtime?.claimId !== claim.claimId || runtime.stopRequested;
    });
  }

  async stopRun(userOpenId: string): Promise<StopRunResult> {
    const request = await this.withUserLock(userOpenId, async () => {
      const session = await this.store.getCurrentSession(userOpenId);
      const runtime = this.runtime.getSessionState(userOpenId);
      const activeRun = runtime?.activeRun ?? getSessionActiveRun(session);
      const canInterrupt = this.canInterruptRun();

      if (!activeRun) {
        if (!runtime) return { status: "none" as const };
        if (!canInterrupt) return { status: "unsupported" as const };
        runtime.stopRequested = true;
        runtime.status = "stopping_run";
        // runtime 存在但 activeRun 不存在，表示 run 还在 starting 阶段，尚未拿到 runId。
        // 这种情况下只能先记录 stopRequested，等 markRunStarted 拿到 runId 后再补 interrupt。
        return { status: "starting" as const };
      }

      if (!canInterrupt) return { status: "unsupported" as const };
      if (runtime) {
        runtime.stopRequested = true;
        runtime.status = "stopping_run";
      }
      return { status: "interrupt" as const, activeRun };
    });

    if (request.status !== "interrupt") return request;

    await this.agent.interruptRun?.(request.activeRun);
    await this.withUserLock(userOpenId, async () => {
      const runtime = this.runtime.getSessionState(userOpenId);
      if (runtime?.activeRun?.runId === request.activeRun.runId) runtime.activeRun = undefined;
      await this.store.clearActiveRun(userOpenId, request.activeRun.runId);
    });
    return { status: "stopped" };
  }

  async endSession(userOpenId: string, chatId: string): Promise<EndSessionResult> {
    const request = await this.withUserLock(userOpenId, async () => {
      const session = await this.store.getCurrentSession(userOpenId);
      const runtime = this.runtime.getSessionState(userOpenId);
      const activeRun = runtime?.activeRun ?? getSessionActiveRun(session);
      if (!session && !runtime && !activeRun) return { shouldEnd: false as const };

      // 先进入 ending_session，再释放锁去 interrupt/等待任务。
      // 后续同用户 prompt 会排在锁后面，不会复用即将被清空的旧 session。
      this.runtime.setSessionState(userOpenId, {
        status: "ending_session",
        claimId: runtime?.claimId,
        activeRun,
        stopRequested: true,
        runTask: runtime?.runTask,
      });
      return { shouldEnd: true as const, session, activeRun, runTask: runtime?.runTask };
    });

    if (!request.shouldEnd) return { status: "none" };
    if (request.activeRun) {
      await this.interruptRunIfSupported(request.activeRun).catch(() => undefined);
    }
    if (request.runTask) await request.runTask.catch(() => undefined);
    await this.disposeSessionIfSupported(request.session);

    await this.withUserLock(userOpenId, async () => {
      const session = await this.store.getCurrentSession(userOpenId);
      if (session) {
        await this.store.upsertCurrentSession({
          ...session,
          agentSessionId: null,
          activeRunId: null,
          lastChatId: chatId,
          updatedAt: Date.now(),
        });
      }
      await this.store.deletePendingApprovalsForUser(userOpenId);
      await this.store.deletePendingUserInputsForUser(userOpenId);
      this.runtime.deleteSessionState(userOpenId);
    });
    return { status: "ended" };
  }

  async startNewSession(userOpenId: string, chatId: string): Promise<NewSessionResult> {
    const request = await this.withUserLock(userOpenId, async () => {
      const session = await this.ensureSessionUnlocked(userOpenId, chatId);
      const runtime = this.runtime.getSessionState(userOpenId);
      const activeRun = runtime?.activeRun ?? getSessionActiveRun(session);
      // /new 不是单纯结束会话，而是“中止旧任务 + 创建新 agent session”，所以用 resetting_session 标识过渡期。
      this.runtime.setSessionState(userOpenId, {
        status: "resetting_session",
        claimId: runtime?.claimId,
        activeRun,
        stopRequested: true,
        runTask: runtime?.runTask,
      });
      return { session, activeRun, runTask: runtime?.runTask };
    });

    if (request.activeRun) {
      await this.interruptRunIfSupported(request.activeRun).catch(() => undefined);
    }
    if (request.runTask) await request.runTask.catch(() => undefined);
    await this.disposeSessionIfSupported(request.session);

    const project = getProject(this.config, request.session.projectKey);
    if (!project) {
      await this.withUserLock(userOpenId, async () => {
        this.runtime.deleteSessionState(userOpenId);
      });
      return { status: "missing_project", projectKey: request.session.projectKey };
    }

    const agentSession = await this.agent.createSession({ project });
    this.runtime.markSessionLoaded(agentSession.id);
    await this.withUserLock(userOpenId, async () => {
      const session = await this.ensureSessionUnlocked(userOpenId, chatId);
      await this.store.upsertCurrentSession({
        ...session,
        agentSessionId: agentSession.id,
        activeRunId: null,
        lastChatId: chatId,
        updatedAt: Date.now(),
      });
      this.runtime.deleteSessionState(userOpenId);
    });
    return { status: "started", projectKey: project.key };
  }

  async switchProject(userOpenId: string, chatId: string, projectKey: string): Promise<SwitchProjectResult> {
    let previousSession: CurrentSession | null = null;
    const result: SwitchProjectResult = await this.withUserLock(userOpenId, async () => {
      const project = getProject(this.config, projectKey);
      if (!project) return { status: "unknown_project" as const, projectKey };

      const session = await this.ensureSessionUnlocked(userOpenId, chatId);
      const snapshot = this.snapshotFrom(userOpenId, session);
      if (snapshot.status !== "idle") return { status: "busy" as const, currentStatus: snapshot.status };

      previousSession = session;
      await this.store.upsertCurrentSession({
        userOpenId,
        projectKey: project.key,
        agentSessionId: null,
        activeRunId: null,
        lastChatId: chatId,
        updatedAt: Date.now(),
      });
      return { status: "switched" as const, projectKey: project.key, projectName: project.name };
    });
    if (result.status === "switched") await this.disposeSessionIfSupported(previousSession);
    return result;
  }

  private async finishPrompt(claim: PromptClaim): Promise<void> {
    await this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.getSessionState(claim.userOpenId);
      if (runtime?.claimId !== claim.claimId) return;

      if (runtime.status === "ending_session" || runtime.status === "resetting_session") {
        // /end 或 /new 已经接管生命周期时，prompt 结束不能删除 runtime；
        // 否则等待中的生命周期命令会丢失“正在结束/重置”的保护状态。
        runtime.claimId = undefined;
        runtime.activeRun = undefined;
        runtime.runTask = undefined;
        runtime.stopRequested = true;
        return;
      }

      this.runtime.deleteSessionState(claim.userOpenId);
    });
  }

  private async openAgentSession(claim: PromptClaim): Promise<AgentSession> {
    const sessionId = claim.session.agentSessionId;
    if (sessionId && this.runtime.isSessionLoaded(sessionId)) {
      return { id: sessionId, resumeSupported: this.agent.capabilities.resumeSession };
    }
    if (sessionId && this.agent.capabilities.resumeSession && this.agent.resumeSession) {
      const agentSession = await this.agent.resumeSession({ sessionId, project: claim.project });
      this.runtime.markSessionLoaded(agentSession.id);
      return agentSession;
    }
    return this.agent.createSession({ project: claim.project });
  }

  private async disposeSessionIfSupported(session: CurrentSession | null): Promise<void> {
    if (!session?.agentSessionId || !this.agent.disposeSession) return;
    const project = getProject(this.config, session.projectKey);
    if (!project) return;
    await this.agent.disposeSession({ sessionId: session.agentSessionId, project }).catch(() => undefined);
  }

  private async interruptRunIfSupported(activeRun: ActiveRun): Promise<boolean> {
    if (!this.canInterruptRun()) return false;
    await this.agent.interruptRun?.(activeRun);
    return true;
  }

  private canInterruptRun(): boolean {
    return Boolean(this.agent.capabilities.interruptRun && this.agent.interruptRun);
  }

  private async ensureSessionUnlocked(userOpenId: string, chatId: string): Promise<CurrentSession> {
    const current = await this.store.getCurrentSession(userOpenId);
    if (current) {
      // 更新 lastChatId，保证 Bot 菜单事件这类没有 messageId 的入口仍能回到最近会话。
      const updated = { ...current, lastChatId: chatId, updatedAt: Date.now() };
      await this.store.upsertCurrentSession(updated);
      return updated;
    }

    const session: CurrentSession = {
      userOpenId,
      projectKey: this.config.projects[0].key,
      agentSessionId: null,
      activeRunId: null,
      lastChatId: chatId,
      updatedAt: Date.now(),
    };
    await this.store.upsertCurrentSession(session);
    return session;
  }

  private snapshotFrom(userOpenId: string, session: CurrentSession | null): SessionSnapshot {
    const runtime = this.runtime.getSessionState(userOpenId);
    const activeRun = runtime?.activeRun ?? getSessionActiveRun(session);
    return {
      userOpenId,
      session,
      status: runtime?.status ?? (activeRun ? "running_run" : "idle"),
      activeRun,
    };
  }

  private activeRunTasks(): Promise<void>[] {
    return this.runtime.activeRunTasks();
  }

  // 按用户串行化生命周期读写：同一个 userOpenId 的操作会接在上一段 promise 后执行。
  // 注意这里不是全局锁，不同用户之间不会互相阻塞。
  private async withUserLock<T>(userOpenId: string, run: () => Promise<T>): Promise<T> {
    return this.runtime.withUserLock(userOpenId, run);
  }
}

function getSessionActiveRun(session: CurrentSession | null): ActiveRun | undefined {
  if (!session?.agentSessionId || !session.activeRunId) return undefined;
  return { sessionId: session.agentSessionId, runId: session.activeRunId };
}
