Feishu Codex Bot
================

Node.js/TypeScript MVP for driving `codex app-server` from Feishu Bot conversations.

## What is implemented

- Feishu long-connection adapter using `WSClient + EventDispatcher`
- Message, card-action, bot-menu, reaction, and connection event normalization
- `codex app-server --listen stdio://` JSON-RPC driver
- Per-Feishu-user current Codex session
- Static project allowlist
- Command routing:
  - `/help`
  - `/projects`
  - `/use <project>`
  - `/new`
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
  codex/
    app-server-driver.ts    `codex app-server` JSON-RPC adapter
    types.ts                Codex port, turn, event, and approval contracts
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

Edit `config.local.json` with your Feishu app credentials, bot open id, allowed users, and static projects.
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

The server expects Codex to already be logged in on the machine running the bot. It uses the same `CODEX_HOME` state as the Codex CLI/app-server.

## MVP behavior

- One current Codex session per Feishu user.
- `/new` starts a fresh Codex thread and replaces that user's current session.
- Ordinary messages use `turn/start`; `turn/steer` is intentionally not used automatically.
- If a turn is already active, the bot asks the user to wait or run `/stop`.
- On service restart, the bot can resume the previous Codex thread history, but it does not guarantee reconnecting to an in-flight turn.
- `bot.debugPromptAcceptedFeedback` can be enabled to send an extra "received" message before each Codex turn during debugging; `--debug` enables it for the current process.

## Validation

```bash
pnpm typecheck
pnpm test
```
