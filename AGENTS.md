# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js 20+ TypeScript service that connects Feishu chat events to a local code-agent runtime. Source lives under `src/`, organized by boundary:

- `src/feishu/`: Feishu long-connection gateway and event types.
- `src/bot/`: command parsing, routing, status reporting, and chat orchestration.
- `src/session/`: per-user session lifecycle and active-run state.
- `src/agent/`: runtime-neutral driver contracts and driver factory.
- `src/codex/`: Codex app-server driver implementation.
- `src/store/`: SQLite persistence.
- `src/config/`: config loading and validation.
- `tests/`: Vitest unit tests named `*.test.ts`.

Generated output and local state are ignored in `dist/`, `data/`, `log/`, and local config files.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies.
- `pnpm dev -- --config ./config.local.json`: run the bot locally.
- `pnpm dev:debug -- --config ./config.local.json`: run with debug behavior enabled.
- `pnpm build`: build ESM output and declarations with `tsup`.
- `pnpm typecheck`: run strict TypeScript checking without emitting files.
- `pnpm test`: run the Vitest suite once.
- `pnpm test:watch`: run Vitest in watch mode.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, and explicit `.js` suffixes for local imports, matching existing files such as `src/index.ts`. Keep two-space indentation, double quotes, semicolons, and small focused modules. Use `PascalCase` for classes and exported types, `camelCase` for functions and variables, and kebab-case filenames such as `run-status-reporter.ts`.

Keep runtime-specific behavior behind `CodeAgentDriver` in `src/agent/types.ts`; Feishu and session policy code should not depend on Codex-specific protocol details.

## Testing Guidelines

Vitest is configured in `vitest.config.ts` with globals and `tests/**/*.test.ts`. Add focused tests near the behavior boundary you change, for example command parsing in `tests/commands.test.ts` or persistence in `tests/sqlite-state-store.test.ts`. Run `pnpm typecheck` and `pnpm test` before submitting changes.

## Commit & Pull Request Guidelines

History uses concise, conventional-style subjects such as `feat: ...`, `docs: ...`, and scoped refactors like `refactor(bot): ...`. Prefer one logical change per commit and include a scope when it clarifies ownership.

Pull requests should include a short summary, validation results, and any config or security impact. For user-facing bot behavior, include sample commands, transcripts, or screenshots of Feishu messages/cards when helpful.

## Security & Configuration Tips

Do not commit `.env`, `config.local.json`, SQLite files, or credentials. Start from `config.example.json`, keep project paths statically configured, and set `allowedUsers` or `allowedChats` before testing outside a controlled chat.
