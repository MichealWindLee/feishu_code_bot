import { BotService } from "./bot/bot-service.js";
import { CodexAppServerDriver } from "./codex/app-server-driver.js";
import { loadConfig, parseCliConfigOptions } from "./config/index.js";
import { WsFeishuGateway } from "./feishu/ws-feishu-gateway.js";
import { SqliteStateStore } from "./store/sqlite-state-store.js";

async function main(): Promise<void> {
  const config = loadConfig(parseCliConfigOptions(process.argv.slice(2)));
  const store = new SqliteStateStore(config.storage.sqlitePath);
  const feishu = new WsFeishuGateway(config);
  const codex = new CodexAppServerDriver(config);
  const service = new BotService(config, feishu, feishu, codex, store);

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await service.start();
  console.log("Feishu Codex Bot started.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
