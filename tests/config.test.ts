import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseCliConfigOptions } from "../src/config/index.js";

describe("config", () => {
  it("parses startup flags for config path and debug mode", () => {
    expect(parseCliConfigOptions(["--config", "./config.local.json", "--env-file", ".env.local", "--debug"])).toEqual({
      configPath: "./config.local.json",
      envPath: ".env.local",
      debugPromptAcceptedFeedback: true,
    });
    expect(parseCliConfigOptions(["--config=./config.local.json", "--no-debug-prompt-accepted-feedback"])).toEqual({
      configPath: "./config.local.json",
      debugPromptAcceptedFeedback: false,
    });
  });

  it("lets startup debug flag override file config", () => {
    const configPath = writeTempConfig({
      bot: {
        approvalTtlMs: 1_800_000,
        eventDedupTtlMs: 86_400_000,
        debugPromptAcceptedFeedback: false,
      },
    });

    const config = loadConfig({
      configPath,
      debugPromptAcceptedFeedback: true,
    });

    expect(config.bot.debugPromptAcceptedFeedback).toBe(true);
  });

  it("loads explicit agent config", () => {
    const configPath = writeTempConfig({
      agent: {
        type: "codex",
        binaryPath: "/bin/codex",
        defaultSandbox: "workspace-write",
        defaultApprovalPolicy: "on-request",
      },
    });

    const config = loadConfig({ configPath });

    expect(config.agent).toEqual(expect.objectContaining({
      type: "codex",
      binaryPath: "/bin/codex",
    }));
  });

  it("keeps agent metadata out of config normalization", () => {
    const configPath = writeTempConfig({
      agent: {
        type: "codex",
        binaryPath: "codex",
        defaultSandbox: "workspace-write",
        defaultApprovalPolicy: "on-request",
      },
    });

    const config = loadConfig({ configPath });

    expect(config.agent).toEqual(expect.objectContaining({
      type: "codex",
      binaryPath: "codex",
    }));
    expect(config.agent).not.toHaveProperty("id");
    expect(config.agent).not.toHaveProperty("displayName");
  });

  it("loads process env from a dotenv file before applying env overrides", () => {
    const configPath = writeTempConfig({
      feishu: {
        appId: "file_app",
        appSecret: "file_secret",
        allowedUsers: [],
        allowedChats: [],
      },
    });
    const envPath = writeTempEnv([
      `FEISHU_CODE_BOT_CONFIG=${configPath}`,
      "FEISHU_APP_ID=env_app",
      "FEISHU_APP_SECRET=env_secret",
    ]);

    withCleanEnv(["FEISHU_CODE_BOT_CONFIG", "FEISHU_APP_ID", "FEISHU_APP_SECRET"], () => {
      const config = loadConfig({ envPath });

      expect(config.feishu.appId).toBe("env_app");
      expect(config.feishu.appSecret).toBe("env_secret");
    });
  });
});

function writeTempConfig(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "feishu-code-bot-config-"));
  const config = {
    feishu: {
      appId: "app",
      appSecret: "secret",
      botOpenId: "bot",
      allowedUsers: [],
      allowedChats: [],
    },
    projects: [{ key: "bot", name: "Bot", path: "." }],
    agent: {
      type: "codex",
      binaryPath: "codex",
      defaultSandbox: "workspace-write",
      defaultApprovalPolicy: "on-request",
    },
    storage: { sqlitePath: ":memory:" },
    ...overrides,
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

function writeTempEnv(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "feishu-code-bot-env-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
  return envPath;
}

function withCleanEnv(keys: string[], fn: () => void): void {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
