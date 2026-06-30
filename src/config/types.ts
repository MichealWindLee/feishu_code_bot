export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export const AGENT_TYPES = ["codex"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export interface AgentConfig {
  type: AgentType;
  binaryPath: string;
  defaultSandbox: SandboxMode;
  defaultApprovalPolicy: ApprovalPolicy;
  model?: string;
}

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
  agent: AgentConfig;
  storage: {
    sqlitePath: string;
  };
  bot: {
    approvalTtlMs: number;
    eventDedupTtlMs: number;
    debugPromptAcceptedFeedback: boolean;
  };
}

export interface LoadConfigOptions {
  configPath?: string;
  envPath?: string;
  debugPromptAcceptedFeedback?: boolean;
}
