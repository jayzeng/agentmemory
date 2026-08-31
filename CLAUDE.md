# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A persistent memory system for coding agents — Claude Code, OpenAI Codex, Cursor, opencode. Provides persistent memory across sessions via plain markdown files, with optional semantic search powered by [qmd](https://github.com/tobi/qmd). Published as `myagentmemory` on npm; binary is `agent-memory`.

## Architecture

```
  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐
  │  src/core.ts │   │ src/hooks.ts │   │ src/plugin-service.ts│
  │  (all logic) │   │ (hook mgmt)  │   │ src/plugin-bootstrap │
  └──────┬───────┘   └──────┬───────┘   │ src/plugin-host      │
         │                  │           │ src/plugin-runtime   │
    ┌────┴──────────────────┴───────┐   └──────────────────────┘
    ▼                               ▼      Pro plugin surface
  ┌──────────┐   ┌──────────────────────────┐
  │ src/cli.ts│   │ skills/                  │
  │ (binary)  │   │ ├─ claude-code/SKILL.md  │
  └──────────┘   │ └─ codex/SKILL.md        │
                 └──────────────────────────┘
```

- **`src/core.ts`**: All shared logic — paths, truncation, scratchpad, context builder, qmd integration, tool functions (`memoryWrite`, `memoryRead`, `scratchpadAction`, `memorySearch`)
- **`src/cli.ts`**: CLI entry point — `agent-memory` binary with all subcommands; imports from core.ts and hooks.ts
- **`src/cli-spec.ts`**: Declarative command/flag spec (`CliOptionSpec`) used by the completions generator
- **`src/completions.ts`**: Shell completion script generation (bash/zsh/fish), driven by cli-spec
- **`src/hooks.ts`**: Install/uninstall session-start hooks into Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/config.toml`), Cursor (`.mdc` rule), and opencode. Claude Code also gets `Stop` (periodic memory-write nudge, every `STOP_NAG_INTERVAL` turns per session), which is write-side, mode-independent, and Claude-Code-only for now
- **`src/plugin-service.ts`**, **`plugin-bootstrap.ts`**, **`plugin-host.ts`**, **`plugin-runtime.ts`**: Plugin protocol for optional Pro tier — `InstalledPluginRuntimeV1` loads the Pro bundle from `~/.agent-memory/plugins/`
- **`skills/`**: SKILL.md files for Claude Code and Codex that invoke the CLI
- **`eval/`**: Token-savings modeling (`token-savings.ts`), LLM feedback eval (`run.ts`), regression dataset

## Commands

```bash
# Build the CLI binary (standalone executable)
bun run build:cli

# Build the npm library (dist/)
bun run build:lib

# Type-check without emitting
bun run build

# Lint
bun run lint           # biome check .

# Tests
bun test test/unit.test.ts         # or: bun run test:unit
bun test test/cli.test.ts          # or: bun run test:cli  (15s timeout)
bun test test/eval.test.ts         # or: bun run test:eval
bun test test/token-savings.test.ts

# Run a single test file
bun test test/cli.test.ts --timeout 15000

# Eval tooling
bun run eval:token-savings         # token cost modeling report (HTML)
bun run eval:feedback              # LLM-graded regression eval

# Install skills into detected agent(s)
bash scripts/install-skills.sh     # or: bun run install-skills
```

## Key Design Patterns

- **Core + CLI separation**: `src/core.ts` owns all logic; `src/cli.ts` is thin dispatch; hooks/completions/plugin files are independent modules consumed by cli.ts
- **Configurable paths**: `AGENT_MEMORY_DIR` env var or `--dir` flag overrides memory dir (default `~/.agent-memory/`)
- **Context injection priority**: scratchpad → today's log → qmd search results → MEMORY.md → yesterday's log
- **qmd integration**: Optional, detected at runtime via `detectQmd()`. All writes schedule a debounced (500ms) `qmd update` fire-and-forget. Semantic search and selective injection require qmd.
- **Scratchpad format**: Markdown checklists with HTML comment metadata (`<!-- timestamp [sessionId] -->`)
- **Plugin protocol**: `InstalledPluginRuntimeV1` (from `plugin-runtime.ts`) is loaded in `cmdContext` to append Pro sections; failures are silently swallowed so Pro never breaks the public core
- **Shell completions**: `src/completions.ts` generates completion scripts from the declarative `CliOptionSpec` in `src/cli-spec.ts`; installed via `agent-memory completions install`

## End-to-End Verification Rule

Before marking any change complete, run the full loop against all three local raw session sources to confirm the pipeline works end-to-end:

1. **Claude Code** — run `agent-memory recall "<recent topic>" --cwd <repo>` and confirm the top hit surfaces the correct session with a rich digest (`goal`, `outcome`, `activeSec`, `topics`).
2. **Codex** — same recall against a Codex-authored session to verify the Codex parser path is indexed correctly.
3. **pi** — same recall against a Pi session to verify the Pi parser path is indexed correctly.
4. **Regression eval** — run `bun run eval:feedback -- --dataset eval/datasets/agent-memory-regression-v1.json` and confirm 0 `failed` probes (product-opportunity findings show as `opportunity`, not `failed`).

After any change to `core.ts`, `cli.ts`, `hooks.ts`, or the plugin surface, also verify `agent-memory context --query "<recent topic>"` output is coherent (context injection pipeline). The `recall` check validates cross-session retrieval; the `context` check validates in-session injection.

## Testing

| Level | File | Requirements | What it tests |
|-------|------|-------------|---------------|
| Unit | `test/unit.test.ts` | None | Utilities, scratchpad parsing, context builder, qmd helpers, tool functions |
| CLI | `test/cli.test.ts` | None | CLI commands via core.ts imports + subprocess tests |
| Eval | `test/eval.test.ts` | None | LLM feedback eval smoke tests |
| Token | `test/token-savings.test.ts` | None | Token-savings model arithmetic |

## Package Exports

`myagentmemory` exposes multiple entry points for downstream consumers (e.g. the AgentMemory Pro plugin):

| Export | Entry point |
|--------|------------|
| Default | `src/core.ts` — tool functions, paths, context builder |
| `./completions` | `src/completions.ts` |
| `./hooks` | `src/hooks.ts` |
| `./plugin-bootstrap` | `src/plugin-bootstrap.ts` — Pro bundle bootstrap |
| `./plugin-host` | `src/plugin-host.ts` — plugin protocol types, interfaces, and validators |
