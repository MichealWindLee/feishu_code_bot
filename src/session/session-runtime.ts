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

export type RuntimeSessionState = {
  status: Exclude<SessionStatus, "idle">;
  claimId?: string;
  activeTurn?: ActiveTurn;
  stopRequested: boolean;
  turnTask?: Promise<void>;
};

export interface SessionRuntime {
  nextClaimId(): string;
  getSessionState(userOpenId: string): RuntimeSessionState | undefined;
  setSessionState(userOpenId: string, state: RuntimeSessionState): void;
  deleteSessionState(userOpenId: string): void;
  activeTurnTasks(): Promise<void>[];
  isThreadLoaded(threadId: string): boolean;
  markThreadLoaded(threadId: string): void;
  withUserLock<T>(userOpenId: string, run: () => Promise<T>): Promise<T>;
}

export class InMemorySessionRuntime implements SessionRuntime {
  // app-server 是服务级共享进程；thread 只需要在当前进程内 resume 一次。
  private readonly loadedThreads = new Set<string>();
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

  activeTurnTasks(): Promise<void>[] {
    return [...this.sessionStates.values()].map((state) => state.turnTask).filter(isDefined);
  }

  isThreadLoaded(threadId: string): boolean {
    return this.loadedThreads.has(threadId);
  }

  markThreadLoaded(threadId: string): void {
    this.loadedThreads.add(threadId);
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
