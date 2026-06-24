export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export interface ProjectConfig {
  key: string;
  name: string;
  path: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  model?: string;
}

export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    botOpenId?: string;
    allowedUsers: string[];
    allowedChats: string[];
  };
  projects: ProjectConfig[];
  codex: {
    binaryPath: string;
    defaultSandbox: SandboxMode;
    defaultApprovalPolicy: ApprovalPolicy;
    model?: string;
  };
  storage: {
    sqlitePath: string;
  };
  bot: {
    approvalTtlMs: number;
    eventDedupTtlMs: number;
    streamFlushMs: number;
    debugPromptAcceptedFeedback: boolean;
  };
}

export interface LoadConfigOptions {
  configPath?: string;
  envPath?: string;
  debugPromptAcceptedFeedback?: boolean;
}
