# Feishu Code Agent Bot

A Node.js/TypeScript service that connects Feishu bot conversations to a local
code-agent runtime. It receives Feishu events over the long-connection channel,
routes authorized messages to configured project workspaces, streams run status
back to chat, and persists session state in SQLite.

The Feishu orchestration layer depends on a neutral `CodeAgentDriver`
interface. Runtime-specific integrations stay behind that boundary, so the
Feishu event handling and session policy do not depend on a single agent
protocol.

## Features

- Feishu long-connection integration based on `WSClient` and `EventDispatcher`.
- Message, card-action, bot-menu, reaction, and connection event normalization.
- Static project registry with per-project sandbox, approval, and model
  overrides.
- Per-user agent sessions with resume support when the configured driver
  supports it.
- Run lifecycle controls for starting, resetting, ending, interrupting, and
  inspecting active sessions.
- User-scoped approval handling through chat commands or interactive card
  actions.
- SQLite persistence for current sessions, pending approvals, and event
  deduplication.

## Architecture

```text
Feishu long connection
  -> WsFeishuGateway
  -> BotService
  -> SessionManager + StateStore
  -> CodeAgentDriver
  -> local code-agent runtime
```

Key directories:

```text
src/
  index.ts                  Process entrypoint and shutdown handling
  agent/
    index.ts                Agent driver factory
    types.ts                Driver contracts for sessions, runs, events, approvals
  bot/
    bot-service.ts          Event routing and prompt orchestration
    command-handler.ts      Command execution
    commands.ts             Command parser and help text
    run-status-reporter.ts  Status-card and final-response aggregation
  codex/
    app-server-driver.ts    Included agent driver
    app-server-events.ts    Runtime event normalization
    app-server-approvals.ts Approval result mapping
  config/
    index.ts                Config loading, environment overrides, validation
    types.ts                Config schema types
  feishu/
    ws-feishu-gateway.ts    Feishu SDK long-connection adapter
    types.ts                Feishu event and outbound message contracts
  session/
    session-manager.ts      Per-user session lifecycle and concurrency control
    session-runtime.ts      In-memory active-run state
  store/
    sqlite-state-store.ts   SQLite-backed persistence
    types.ts                Persistence contracts
  shared/
    async-queue.ts          Async iterable queue utility
```

## Requirements

- Node.js 20 or newer.
- pnpm.
- A Feishu app with bot access, long connection enabled, and the required IM
  event subscriptions and message permissions.
- A local code-agent runtime available on the host. For the included driver,
  the configured binary must be installed and authenticated for the same OS user
  that runs this service.

## Configuration

Create local configuration files from the examples:

```bash
pnpm install
cp config.example.json config.local.json
cp .env.example .env
```

Edit `config.local.json` before starting the service:

| Field | Purpose |
| --- | --- |
| `feishu.appId` / `feishu.appSecret` | Feishu app credentials. |
| `feishu.botOpenId` | Optional bot open id. If omitted, the service resolves it at startup. |
| `feishu.allowedUsers` | Open-id allowlist. An empty array allows all users. |
| `feishu.allowedChats` | Group-chat allowlist. Group messages must also mention the bot. |
| `projects` | Static project workspaces that users can select with `/use`. |
| `agent` | Driver type, optional display name, binary path, and default sandbox or approval policy. |
| `storage.sqlitePath` | SQLite file used for sessions, approvals, and event deduplication. |
| `bot.approvalTtlMs` | Pending approval lifetime in milliseconds. |
| `bot.eventDedupTtlMs` | Feishu event deduplication lifetime in milliseconds. |
| `bot.debugPromptAcceptedFeedback` | Sends an extra "accepted" message before each run when enabled. |

Environment variables can override common local settings:

```bash
FEISHU_CODE_BOT_CONFIG=./config.local.json
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx
SQLITE_PATH=./data/bot.sqlite
```

Do not commit local credentials, `.env`, or machine-specific config files.

## Running

Start the service with the default `.env` loading behavior:

```bash
FEISHU_CODE_BOT_CONFIG=./config.local.json pnpm dev
```

Or pass options explicitly:

```bash
pnpm dev -- --config ./config.local.json
pnpm dev -- --env-file ./.env.local
pnpm dev -- --config ./config.local.json --debug
pnpm dev:debug -- --config ./config.local.json
```

Build the package:

```bash
pnpm build
```

To run multiple bot instances locally, give each process a separate config and
SQLite path:

```bash
pnpm dev -- --config ./config.team-a.json
pnpm dev -- --config ./config.team-b.json
```

## Chat Commands

| Command | Description |
| --- | --- |
| `/help` | Show available commands. |
| `/projects` | List configured projects. |
| `/use <project>` | Switch the current user to a configured project. |
| `/new` | Start a fresh agent session for the current project. |
| `/end` | Clear the current session binding and pending approvals. |
| `/status` | Show the current project, session id, and active run state. |
| `/stop` | Interrupt the active run when the driver supports interruption. |
| `/permissions` | Show the sandbox, approval policy, and driver capabilities. |
| `/approve <id>` | Approve a pending agent request. |
| `/deny <id>` | Deny a pending agent request. |

Ordinary chat messages are treated as prompts for the current project. In group
chats, the bot only handles messages that mention it and pass the configured
allowlists.

## Security Notes

- Project paths are configured statically. Users cannot choose arbitrary
  workspaces from chat.
- User and group allowlists should be set before deploying the bot outside a
  controlled test chat.
- Sandbox and approval policies are passed to the configured agent runtime. The
  runtime still executes on the host machine, so run this service under a
  dedicated OS account with appropriate filesystem permissions.
- SQLite state can contain session identifiers and serialized approval payloads.
  Protect the configured database path as application state.

## Development

Run validation before sending changes:

```bash
pnpm typecheck
pnpm test
```

The driver boundary lives in `src/agent/types.ts`. A new runtime integration
should implement `CodeAgentDriver`, declare its capabilities accurately, and keep
events JSON-serializable so the Feishu layer does not depend on runtime-specific
protocol details.
