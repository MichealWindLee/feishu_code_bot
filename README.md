Feishu Code Agent Bot
=====================

Node.js/TypeScript MVP for driving a configured code agent from Feishu Bot conversations. The first adapter uses `codex app-server`; the bot service talks to a neutral `CodeAgentDriver` interface so later adapters such as Claude Code or Trae CLI can be added without changing the Feishu-facing orchestration.

## What is implemented

- Feishu long-connection adapter using `WSClient + EventDispatcher`
- Message, card-action, bot-menu, reaction, and connection event normalization
- Neutral code-agent driver contract with Codex as the first adapter
- `codex app-server --listen stdio://` JSON-RPC adapter
- Per-Feishu-user current agent session
- Static project allowlist
- Command routing:
  - `/help`
  - `/projects`
  - `/use <project>`
  - `/new`
  - `/end`
  - `/status`
  - `/stop`
  - `/permissions`
  - `/approve <id>`
  - `/deny <id>`
- Minimal SQLite state for current sessions, pending approvals, and event deduplication

## Module layout

```text
src/
  index.ts                  Process entrypoint and lifecycle wiring
  bot/
    bot-service.ts          Conversation routing, command dispatch, session orchestration
    commands.ts             Bot command parser and help text
  agent/
    index.ts                Agent driver factory
    types.ts                Code agent session, run, event, and approval contracts
  codex/
    app-server-driver.ts    `codex app-server` JSON-RPC adapter
  config/
    index.ts                Config loading, CLI flags, env overrides, validation
    types.ts                Config and project types
  feishu/
    ws-feishu-gateway.ts    Feishu SDK long-connection adapter and message sender
    types.ts                Feishu inbound events and outbound port contracts
  store/
    sqlite-state-store.ts   SQLite implementation
    types.ts                Persistence contracts and state records
  shared/
    async-queue.ts          Small async iterable queue utility
```

## Setup

```bash
pnpm install
cp config.example.json config.local.json
cp .env.example .env
```

Edit `config.local.json` with your Feishu app credentials, bot open id, allowed users, static projects, and the configured `agent`.
Edit `.env` if you want environment-based overrides. The service loads `.env` automatically before reading `process.env`.

```bash
FEISHU_CODE_BOT_CONFIG=./config.local.json pnpm dev
pnpm dev
```

You can also pass the config path and debug mode as startup arguments:

```bash
pnpm dev -- --config ./config.local.json
pnpm dev -- --env-file ./.env.local
pnpm dev -- --config ./config.local.json --debug
pnpm dev:debug -- --config ./config.local.json
```

For the Codex adapter, the server expects Codex to already be logged in on the machine running the bot. It uses the same `CODEX_HOME` state as the Codex CLI/app-server.

The preferred first-stage deployment model is one service instance per Feishu bot and one configured agent per service. To run multiple bots locally, start multiple processes with different configs and SQLite paths:

```bash
pnpm dev -- --config ./config.codex.json
pnpm dev -- --config ./config.claude.json
```

## MVP behavior

- One current agent session per Feishu user.
- `/new` stops the current run when supported, discards the old context, and creates a fresh agent session.
- `/end` clears the current agent session binding and pending approvals; adapters may optionally dispose their own runtime state.
- Ordinary messages start a new agent run in the current session.
- If a run is already active, the bot asks the user to wait or run `/stop`.
- `/stop` interrupts the active run only when the configured driver declares `interruptRun` support.
- On service restart, the bot resumes the previous agent session only when the driver declares `resumeSession` support; otherwise it creates a fresh session on the next prompt.
- `bot.debugPromptAcceptedFeedback` can be enabled to send an extra "received" message before each agent run during debugging; `--debug` enables it for the current process.

## Validation

```bash
pnpm typecheck
pnpm test
```
