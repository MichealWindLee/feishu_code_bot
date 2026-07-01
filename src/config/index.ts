import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { AGENT_TYPES, type AgentConfig, type AppConfig, type ApprovalPolicy, type LoadConfigOptions, type SandboxMode } from "./types.js";

let defaultDotenvLoaded = false;

const defaultConfig: AppConfig = {
  feishu: {
    appId: "",
    appSecret: "",
    botOpenId: undefined,
    allowedUsers: [],
    allowedChats: [],
  },
  projects: [],
  agent: {
    type: "codex",
    binaryPath: "codex",
    defaultSandbox: "workspace-write",
    defaultApprovalPolicy: "on-request",
  },
  storage: {
    sqlitePath: "./data/bot.sqlite",
  },
  bot: {
    approvalTtlMs: 30 * 60 * 1000,
    eventDedupTtlMs: 24 * 60 * 60 * 1000,
    debugPromptAcceptedFeedback: false,
  },
};

export function parseCliConfigOptions(argv: string[]): LoadConfigOptions {
  const options: LoadConfigOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--debug" || arg === "--debug-prompt-accepted-feedback") {
      options.debugPromptAcceptedFeedback = true;
      continue;
    }
    if (arg === "--no-debug-prompt-accepted-feedback") {
      options.debugPromptAcceptedFeedback = false;
      continue;
    }
    if (arg === "--env-file" || arg === "-e") {
      const envPath = argv[index + 1];
      if (!envPath) throw new Error(`${arg} requires a dotenv file path`);
      options.envPath = envPath;
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      options.envPath = arg.slice("--env-file=".length);
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const configPath = argv[index + 1];
      if (!configPath) throw new Error(`${arg} requires a config path`);
      options.configPath = configPath;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
    }
  }

  return options;
}

export function loadConfig(options: LoadConfigOptions | string = {}): AppConfig {
  const loadOptions: LoadConfigOptions = typeof options === "string" ? { configPath: options } : options;
  loadEnvFile(loadOptions.envPath);
  const configPath = loadOptions.configPath ?? process.env.FEISHU_CODE_BOT_CONFIG;
  const fromFile = configPath ? readJson(configPath) : {};
  const merged = deepMerge(defaultConfig, fromFile) as AppConfig;

  if (process.env.FEISHU_APP_ID) merged.feishu.appId = process.env.FEISHU_APP_ID;
  if (process.env.FEISHU_APP_SECRET) merged.feishu.appSecret = process.env.FEISHU_APP_SECRET;
  if (process.env.FEISHU_BOT_OPEN_ID) merged.feishu.botOpenId = process.env.FEISHU_BOT_OPEN_ID;
  if (process.env.CODEX_BINARY_PATH && merged.agent.type === "codex") merged.agent.binaryPath = process.env.CODEX_BINARY_PATH;
  if (process.env.SQLITE_PATH) merged.storage.sqlitePath = process.env.SQLITE_PATH;
  if (loadOptions.debugPromptAcceptedFeedback !== undefined) {
    merged.bot.debugPromptAcceptedFeedback = loadOptions.debugPromptAcceptedFeedback;
  }

  normalizeConfig(merged);
  validateConfig(merged);
  return merged;
}

function loadEnvFile(envPath: string | undefined): void {
  if (envPath) {
    loadDotenv({ path: resolve(envPath), quiet: true });
    return;
  }
  if (!defaultDotenvLoaded) {
    loadDotenv({ quiet: true });
    defaultDotenvLoaded = true;
  }
}

function readJson(configPath: string): unknown {
  const abs = resolve(configPath);
  return JSON.parse(readFileSync(abs, "utf8"));
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConfig(config: AppConfig): void {
  for (const project of config.projects) {
    project.path = resolve(project.path);
  }
  if (config.storage.sqlitePath !== ":memory:") {
    config.storage.sqlitePath = resolve(config.storage.sqlitePath);
  }
}

function validateConfig(config: AppConfig): void {
  if (!config.feishu.appId) throw new Error("Missing feishu.appId or FEISHU_APP_ID");
  if (!config.feishu.appSecret) throw new Error("Missing feishu.appSecret or FEISHU_APP_SECRET");
  if (config.projects.length === 0) throw new Error("At least one static project is required");

  const projectKeys = new Set<string>();
  for (const project of config.projects) {
    if (!project.key || !/^[a-zA-Z0-9_-]+$/.test(project.key)) {
      throw new Error(`Invalid project key: ${project.key}`);
    }
    if (projectKeys.has(project.key)) throw new Error(`Duplicate project key: ${project.key}`);
    projectKeys.add(project.key);
    if (!project.path) throw new Error(`Project ${project.key} is missing path`);
    if (project.sandbox) assertSandbox(project.sandbox);
    if (project.approvalPolicy) assertApprovalPolicy(project.approvalPolicy);
  }
  validateAgent(config.agent);
}

function assertSandbox(value: SandboxMode): void {
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new Error(`Invalid sandbox mode: ${value}`);
  }
}

function assertApprovalPolicy(value: ApprovalPolicy): void {
  if (!["untrusted", "on-failure", "on-request", "never"].includes(value)) {
    throw new Error(`Invalid approval policy: ${value}`);
  }
}

export function getProject(config: AppConfig, key: string | undefined) {
  if (!key) return config.projects[0];
  return config.projects.find((project) => project.key === key) ?? null;
}

function validateAgent(agent: AgentConfig): void {
  if (!isAgentType(agent.type)) throw new Error(`Unsupported agent type: ${(agent as { type?: string }).type}`);
  if (agent.displayName !== undefined && (typeof agent.displayName !== "string" || agent.displayName.trim().length === 0)) {
    throw new Error("Invalid agent.displayName");
  }
  if (!agent.binaryPath) throw new Error("Missing agent.binaryPath");
  assertSandbox(agent.defaultSandbox);
  assertApprovalPolicy(agent.defaultApprovalPolicy);
}

function isAgentType(value: unknown): boolean {
  return typeof value === "string" && (AGENT_TYPES as readonly string[]).includes(value);
}
