import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseCliConfigOptions } from "../src/config/index.js";

describe("config", () => {
  it("parses startup flags for config path and debug mode", () => {
    expect(parseCliConfigOptions(["--config", "./config.local.json", "--debug"])).toEqual({
      configPath: "./config.local.json",
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
        streamFlushMs: 1200,
        debugPromptAcceptedFeedback: false,
      },
    });

    const config = loadConfig({
      configPath,
      debugPromptAcceptedFeedback: true,
    });

    expect(config.bot.debugPromptAcceptedFeedback).toBe(true);
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
    codex: {
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
