export type SessionStatus =
  | "idle"
  | "starting_run"
  | "running_run"
  | "stopping_run"
  | "ending_session"
  | "resetting_session";

export type ActiveRun = {
  sessionId: string;
  runId: string;
};

export type RuntimeSessionState = {
  status: Exclude<SessionStatus, "idle">;
  claimId?: string;
  activeRun?: ActiveRun;
  stopRequested: boolean;
  runTask?: Promise<void>;
};

export interface SessionRuntime {
  nextClaimId(): string;
  getSessionState(userOpenId: string): RuntimeSessionState | undefined;
  setSessionState(userOpenId: string, state: RuntimeSessionState): void;
  deleteSessionState(userOpenId: string): void;
  activeRunTasks(): Promise<void>[];
  isSessionLoaded(sessionId: string): boolean;
  markSessionLoaded(sessionId: string): void;
  withUserLock<T>(userOpenId: string, run: () => Promise<T>): Promise<T>;
}

export class InMemorySessionRuntime implements SessionRuntime {
  // 某些 agent 的 session 只需要在当前进程内 resume 一次。
  private readonly loadedSessions = new Set<string>();
  // 只保存单实例内的临时生命周期状态；可恢复的长期状态仍然以 StateStore 为准。
  private readonly sessionStates = new Map<string, RuntimeSessionState>();
  private readonly userLocks = new Map<string, Promise<void>>();
  private nextClaimSeq = 1;

  nextClaimId(): string {
    return String(this.nextClaimSeq++);
  }

  getSessionState(userOpenId: string): RuntimeSessionState | undefined {
    return this.sessionStates.get(userOpenId);
  }

  setSessionState(userOpenId: string, state: RuntimeSessionState): void {
    this.sessionStates.set(userOpenId, state);
  }

  deleteSessionState(userOpenId: string): void {
    this.sessionStates.delete(userOpenId);
  }

  activeRunTasks(): Promise<void>[] {
    return [...this.sessionStates.values()].map((state) => state.runTask).filter(isDefined);
  }

  isSessionLoaded(sessionId: string): boolean {
    return this.loadedSessions.has(sessionId);
  }

  markSessionLoaded(sessionId: string): void {
    this.loadedSessions.add(sessionId);
  }

  async withUserLock<T>(userOpenId: string, run: () => Promise<T>): Promise<T> {
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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
