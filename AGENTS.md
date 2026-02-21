# Repository Guidelines

## Project Structure & Module Organization

- `src/core.ts`: all logic — paths, truncation, scratchpad, context builder, qmd integration, standalone tool functions (`memoryWrite`, `memoryRead`, `scratchpadAction`, `memorySearch`)
- `src/cli.ts`: CLI entry point — subcommands (context/write/read/scratchpad/search/init/status), compiles to `dist/agent-memory` binary
- `skills/claude-code/SKILL.md`: Claude Code skill file
- `skills/codex/SKILL.md`: Codex skill file
- `skills/cursor/SKILL.md`: Cursor skill file
- `skills/agent/SKILL.md`: Agent (Cursor CLI) skill file
- `test/unit.test.ts`, `test/cli.test.ts`: unit tests (bun:test)
- `README.md`: user-facing install/usage docs

Runtime data lives outside the repo under the memory directory:
- Default: `~/.agent-memory/` (configurable via `AGENT_MEMORY_DIR`)

Files: `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`

## Activity Tracking (Required)

- Track all work sessions by writing a short entry to the daily log using `agent-memory write --target daily`.
- Summaries should include what changed, files touched, and any notable decisions.
- Use the scratchpad tool for follow-ups or TODOs discovered during work.

## Build, Test, and Development Commands

- `bun run build:cli`: compile CLI binary to `dist/agent-memory`
- `npm run build:lib`: emit `dist/` library build via `tsc`
- `npm run build`: typecheck with `tsc` (`--noEmit`)
- `npm run lint`: lint with Biome
- `bun test test/unit.test.ts` or `npm run test:unit`: run unit tests (no LLM/qmd needed)
- `bun test test/cli.test.ts` or `npm run test:cli`: run CLI unit tests
- `bash scripts/install-skills.sh` or `npm run install-skills`: install SKILL.md files for Claude Code and Codex
- Optional (for `memory_search`, requires Bun): `command -v qmd >/dev/null 2>&1 || bun install -g https://github.com/tobi/qmd`
- Optional search setup: `agent-memory init` (auto-creates qmd collection); run `qmd embed` once for semantic/deep search

## Coding Style & Naming Conventions

- `src/core.ts` has zero external dependencies: only `node:fs`, `node:path`, `node:child_process`.
- Match existing formatting: tabs for indentation, semicolons, and double quotes.
- Naming: `camelCase` for functions, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for constants; tool names remain `snake_case` (e.g. `memory_write`).

## Testing Guidelines

- Tests touch memory directories; ensure backups/restores remain intact and new tests don't leak user data.
- Unit tests use temp directories via `_setBaseDir()` — no real memory files.
- Prefer behavior-focused assertions (file contents, cross-session recall). Keep timeouts generous for model latency.

## Pre-Commit Checklist (Required)

Before every `git add`, `commit`, and `push`, you **must** run and verify all pass:

1. `bun test test/unit.test.ts` — unit tests
2. `bun test test/cli.test.ts` — CLI tests
3. `bun run lint` — Biome linting and formatting
4. `bun run build` — TypeScript type-checking

Do not commit or push if any of the above fail. Fix issues first.

## Changelog (Required)

- Maintain `CHANGELOG.md` at the project root.
- For every version bump, add an entry documenting Added, Changed, Fixed, and Removed sections as applicable.
- Review local + committed git changes (`git log`, `git diff`) to draft accurate changelog entries.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) and keep messages imperative.
- PRs: include a short summary, exact test command(s) run, and call out any changes to on-disk memory formats or `qmd` behavior.

## Security & Configuration Tips

- `AGENT_MEMORY_DIR` controls the memory directory (default: `~/.agent-memory`).
- `AGENT_MEMORY_QMD_UPDATE` controls qmd updates after writes (`background`, `manual`, `off`). `PI_MEMORY_QMD_UPDATE` is a legacy fallback.
- Never commit real memory files or secrets.
