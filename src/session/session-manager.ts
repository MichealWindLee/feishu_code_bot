import { getProject } from "../config/index.js";
import type { AppConfig, ProjectConfig } from "../config/types.js";
import type { CodexDriver, CodexThread } from "../codex/types.js";
import type { CurrentSession, StateStore } from "../store/types.js";

export type SessionStatus =
  | "idle"
  | "starting_turn"
  | "running_turn"
  | "stopping_turn"
  | "ending_session"
  | "resetting_session";

export type ActiveTurn = {
  threadId: string;
  turnId: string;
};

export type SessionSnapshot = {
  userOpenId: string;
  session: CurrentSession | null;
  status: SessionStatus;
  activeTurn?: ActiveTurn;
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

export type EnsureThreadResult =
  | { ok: true; thread: CodexThread }
  | { ok: false; reason: "stopped" };

export type StopTurnResult =
  | { status: "stopped" }
  | { status: "starting" }
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

type RuntimeSessionState = {
  status: Exclude<SessionStatus, "idle">;
  claimId?: string;
  activeTurn?: ActiveTurn;
  stopRequested: boolean;
  turnTask?: Promise<void>;
};

export class SessionManager {
  // app-server 是服务级共享进程；thread 只需要在当前进程内 resume 一次，避免重复 resume 同一个历史 thread。
  private readonly loadedThreads = new Set<string>();
  // runtime 只保存单实例内的临时生命周期状态；可恢复的长期状态仍然以 StateStore 为准。
  private readonly runtime = new Map<string, RuntimeSessionState>();
  // 同一个 Feishu 用户的 /end、/new、/stop、prompt 必须串行，否则会互相覆盖 current_sessions。
  private readonly userLocks = new Map<string, Promise<void>>();
  private nextClaimId = 1;

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly codex: CodexDriver,
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
        claimId: String(this.nextClaimId++),
        userOpenId,
        chatId,
        session,
        project,
      };
      // 先同步占住 starting_turn，再让 BotService 异步启动 Codex turn。
      // 这样 /end 或第二条 prompt 不会在 startTurn 尚未返回 turnId 时误判为空闲。
      this.runtime.set(userOpenId, {
        status: "starting_turn",
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
    const runtime = this.runtime.get(claim.userOpenId);
    // turnTask 让 /end、/new、waitForIdle 可以等待当前 prompt 的异步主流程收尾。
    if (runtime?.claimId === claim.claimId) runtime.turnTask = task;
    return task;
  }

  async waitForIdle(): Promise<void> {
    // drain 语义：等待一批 turnTask 结束后，收尾逻辑可能又注册了新的任务或状态，
    // 所以需要重新取快照，直到 runtime 中确实没有仍在执行的 turnTask。
    let tasks = this.activeTurnTasks();
    while (tasks.length > 0) {
      await Promise.allSettled(tasks);
      tasks = this.activeTurnTasks();
    }
  }

  async ensureThread(claim: PromptClaim): Promise<EnsureThreadResult> {
    if (await this.isStopRequested(claim)) return { ok: false, reason: "stopped" };

    // start/resume thread 可能比较慢，不能长时间持有用户锁；否则 /stop 或 /end 会被卡住。
    // 因此这里先执行 Codex 调用，回来后再用 claimId + stopRequested 复核状态是否仍有效。
    const thread = claim.session.codexThreadId
      ? await this.resumeThreadIfNeeded(claim.session.codexThreadId, claim.project)
      : await this.codex.startThread({ project: claim.project });

    return this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.get(claim.userOpenId);
      // 用户可能在 start/resume 期间发了 /stop、/end 或 /new；旧 claim 不允许继续写 session。
      if (runtime?.claimId !== claim.claimId || runtime.stopRequested) {
        return { ok: false, reason: "stopped" };
      }

      this.loadedThreads.add(thread.id);
      if (!claim.session.codexThreadId) {
        const session = await this.ensureSessionUnlocked(claim.userOpenId, claim.chatId);
        await this.store.upsertCurrentSession({
          ...session,
          codexThreadId: thread.id,
          updatedAt: Date.now(),
        });
        claim.session = { ...session, codexThreadId: thread.id, updatedAt: Date.now() };
      }
      return { ok: true, thread };
    });
  }

  async markTurnStarted(claim: PromptClaim, threadId: string, turnId: string): Promise<{ shouldInterrupt: boolean }> {
    return this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.get(claim.userOpenId);
      // turn_started 到达时，如果当前 claim 已经不是最新 claim，说明这是旧异步任务的回调。
      // 此时不能写入当前 session，但现在已经拿到 turnId，调用方应该立刻 interrupt 这个过期 turn。
      if (runtime?.claimId !== claim.claimId) return { shouldInterrupt: true };

      const activeTurn = { threadId, turnId };
      runtime.activeTurn = activeTurn;
      runtime.status = runtime.stopRequested ? "stopping_turn" : "running_turn";
      const session = await this.ensureSessionUnlocked(claim.userOpenId, claim.chatId);
      await this.store.upsertCurrentSession({
        ...session,
        codexThreadId: threadId,
        activeTurnId: turnId,
        updatedAt: Date.now(),
      });
      // /stop、/end、/new 可能发生在 startTurn 发出之后、turn_started 返回之前。
      // 那个窗口里还没有 turnId，不能真正 interrupt；这里拿到 turnId 后补发 interrupt。
      return { shouldInterrupt: runtime.stopRequested };
    });
  }

  async completeTurn(claim: PromptClaim, turnId: string): Promise<void> {
    await this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.get(claim.userOpenId);
      // 旧 turn 的 completed/error 不允许清理新 claim 的 activeTurn。
      if (runtime?.claimId !== claim.claimId) return;
      if (runtime.activeTurn?.turnId === turnId) runtime.activeTurn = undefined;
      await this.store.clearActiveTurn(claim.userOpenId, turnId);
    });
  }

  async failTurn(claim: PromptClaim, turnId?: string): Promise<void> {
    await this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.get(claim.userOpenId);
      // 与 completeTurn 一样，只有当前 claim 才能清理当前 session 的 turn 状态。
      if (runtime?.claimId !== claim.claimId) return;
      runtime.activeTurn = undefined;
      await this.store.clearActiveTurn(claim.userOpenId, turnId);
    });
  }

  async isStopRequested(claim: PromptClaim): Promise<boolean> {
    return this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.get(claim.userOpenId);
      // claim 失效时，对调用方等价于“请停止”；这样旧异步流程会自然退出。
      return runtime?.claimId !== claim.claimId || runtime.stopRequested;
    });
  }

  async stopTurn(userOpenId: string): Promise<StopTurnResult> {
    const request = await this.withUserLock(userOpenId, async () => {
      const session = await this.store.getCurrentSession(userOpenId);
      const runtime = this.runtime.get(userOpenId);
      const activeTurn = runtime?.activeTurn ?? getSessionActiveTurn(session);
      if (runtime) {
        runtime.stopRequested = true;
        runtime.status = "stopping_turn";
      }
      // runtime 存在但 activeTurn 不存在，表示 turn 还在 starting 阶段，尚未拿到 turnId。
      // 这种情况下只能先记录 stopRequested，等 markTurnStarted 拿到 turnId 后再补 interrupt。
      if (!activeTurn) return { activeTurn: undefined, starting: Boolean(runtime) };
      return { activeTurn, starting: false };
    });

    if (!request.activeTurn) return request.starting ? { status: "starting" } : { status: "none" };

    await this.codex.interruptTurn(request.activeTurn);
    await this.withUserLock(userOpenId, async () => {
      const runtime = this.runtime.get(userOpenId);
      if (runtime?.activeTurn?.turnId === request.activeTurn?.turnId) runtime.activeTurn = undefined;
      await this.store.clearActiveTurn(userOpenId, request.activeTurn?.turnId);
    });
    return { status: "stopped" };
  }

  async endSession(userOpenId: string, chatId: string): Promise<EndSessionResult> {
    const request = await this.withUserLock(userOpenId, async () => {
      const session = await this.store.getCurrentSession(userOpenId);
      const runtime = this.runtime.get(userOpenId);
      const activeTurn = runtime?.activeTurn ?? getSessionActiveTurn(session);
      if (!session && !runtime && !activeTurn) return { shouldEnd: false as const };

      // 先进入 ending_session，再释放锁去 interrupt/等待任务。
      // 后续同用户 prompt 会排在锁后面，不会复用即将被清空的旧 thread。
      this.runtime.set(userOpenId, {
        status: "ending_session",
        claimId: runtime?.claimId,
        activeTurn,
        stopRequested: true,
        turnTask: runtime?.turnTask,
      });
      return { shouldEnd: true as const, activeTurn, turnTask: runtime?.turnTask };
    });

    if (!request.shouldEnd) return { status: "none" };
    if (request.activeTurn) {
      await this.codex.interruptTurn(request.activeTurn).catch(() => undefined);
    }
    if (request.turnTask) await request.turnTask.catch(() => undefined);

    await this.withUserLock(userOpenId, async () => {
      const session = await this.store.getCurrentSession(userOpenId);
      if (session) {
        await this.store.upsertCurrentSession({
          ...session,
          codexThreadId: null,
          activeTurnId: null,
          lastChatId: chatId,
          updatedAt: Date.now(),
        });
      }
      await this.store.deletePendingApprovalsForUser(userOpenId);
      this.runtime.delete(userOpenId);
    });
    return { status: "ended" };
  }

  async startNewSession(userOpenId: string, chatId: string): Promise<NewSessionResult> {
    const request = await this.withUserLock(userOpenId, async () => {
      const session = await this.ensureSessionUnlocked(userOpenId, chatId);
      const runtime = this.runtime.get(userOpenId);
      const activeTurn = runtime?.activeTurn ?? getSessionActiveTurn(session);
      // /new 不是单纯结束会话，而是“中止旧任务 + 创建新 thread”，所以用 resetting_session 标识过渡期。
      this.runtime.set(userOpenId, {
        status: "resetting_session",
        claimId: runtime?.claimId,
        activeTurn,
        stopRequested: true,
        turnTask: runtime?.turnTask,
      });
      return { session, activeTurn, turnTask: runtime?.turnTask };
    });

    if (request.activeTurn) {
      await this.codex.interruptTurn(request.activeTurn).catch(() => undefined);
    }
    if (request.turnTask) await request.turnTask.catch(() => undefined);

    const project = getProject(this.config, request.session.projectKey);
    if (!project) {
      await this.withUserLock(userOpenId, async () => {
        this.runtime.delete(userOpenId);
      });
      return { status: "missing_project", projectKey: request.session.projectKey };
    }

    const thread = await this.codex.startThread({ project });
    this.loadedThreads.add(thread.id);
    await this.withUserLock(userOpenId, async () => {
      const session = await this.ensureSessionUnlocked(userOpenId, chatId);
      await this.store.upsertCurrentSession({
        ...session,
        codexThreadId: thread.id,
        activeTurnId: null,
        lastChatId: chatId,
        updatedAt: Date.now(),
      });
      this.runtime.delete(userOpenId);
    });
    return { status: "started", projectKey: project.key };
  }

  async switchProject(userOpenId: string, chatId: string, projectKey: string): Promise<SwitchProjectResult> {
    return this.withUserLock(userOpenId, async () => {
      const project = getProject(this.config, projectKey);
      if (!project) return { status: "unknown_project", projectKey };

      const session = await this.ensureSessionUnlocked(userOpenId, chatId);
      const snapshot = this.snapshotFrom(userOpenId, session);
      if (snapshot.status !== "idle") return { status: "busy", currentStatus: snapshot.status };

      await this.store.upsertCurrentSession({
        userOpenId,
        projectKey: project.key,
        codexThreadId: null,
        activeTurnId: null,
        lastChatId: chatId,
        updatedAt: Date.now(),
      });
      return { status: "switched", projectKey: project.key, projectName: project.name };
    });
  }

  private async finishPrompt(claim: PromptClaim): Promise<void> {
    await this.withUserLock(claim.userOpenId, async () => {
      const runtime = this.runtime.get(claim.userOpenId);
      if (runtime?.claimId !== claim.claimId) return;

      if (runtime.status === "ending_session" || runtime.status === "resetting_session") {
        // /end 或 /new 已经接管生命周期时，prompt 结束不能删除 runtime；
        // 否则等待中的生命周期命令会丢失“正在结束/重置”的保护状态。
        runtime.claimId = undefined;
        runtime.activeTurn = undefined;
        runtime.turnTask = undefined;
        runtime.stopRequested = true;
        return;
      }

      this.runtime.delete(claim.userOpenId);
    });
  }

  private async resumeThreadIfNeeded(threadId: string, project: ProjectConfig): Promise<CodexThread> {
    // loadedThreads 是当前 app-server 进程内的缓存；服务重启后会重新 resume。
    if (this.loadedThreads.has(threadId)) return { id: threadId };
    const thread = await this.codex.resumeThread(threadId, { threadId, project });
    this.loadedThreads.add(thread.id);
    return thread;
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
      codexThreadId: null,
      activeTurnId: null,
      lastChatId: chatId,
      updatedAt: Date.now(),
    };
    await this.store.upsertCurrentSession(session);
    return session;
  }

  private snapshotFrom(userOpenId: string, session: CurrentSession | null): SessionSnapshot {
    const runtime = this.runtime.get(userOpenId);
    const activeTurn = runtime?.activeTurn ?? getSessionActiveTurn(session);
    return {
      userOpenId,
      session,
      status: runtime?.status ?? (activeTurn ? "running_turn" : "idle"),
      activeTurn,
    };
  }

  private activeTurnTasks(): Promise<void>[] {
    return [...this.runtime.values()].map((state) => state.turnTask).filter(isDefined);
  }

  // 按用户串行化生命周期读写：同一个 userOpenId 的操作会接在上一段 promise 后执行。
  // 注意这里不是全局锁，不同用户之间不会互相阻塞。
  private async withUserLock<T>(userOpenId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.userLocks.get(userOpenId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.userLocks.set(userOpenId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      // 释放当前锁；如果期间没有新的 tail 接上来，就从 Map 移除，避免长期运行时按用户累积。
      release();
      if (this.userLocks.get(userOpenId) === tail) this.userLocks.delete(userOpenId);
    }
  }
}

function getSessionActiveTurn(session: CurrentSession | null): ActiveTurn | undefined {
  if (!session?.codexThreadId || !session.activeTurnId) return undefined;
  return { threadId: session.codexThreadId, turnId: session.activeTurnId };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
