import type { AppConfig } from "../config/types.js";
import { CodexAppServerDriver } from "../codex/app-server-driver.js";
import type { CodeAgentDriver } from "./types.js";

export function createCodeAgentDriver(config: AppConfig): CodeAgentDriver {
  switch (config.agent.type) {
    case "codex":
      return new CodexAppServerDriver(config);
    default:
      throw new Error(`Unsupported agent type: ${(config.agent as { type?: string }).type}`);
  }
}
