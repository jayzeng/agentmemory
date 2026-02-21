# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A persistent memory system for coding agents — Claude Code and OpenAI Codex. Provides persistent memory across coding sessions via plain markdown files, with optional semantic search powered by [qmd](https://github.com/tobi/qmd).

## Architecture

```
  ┌──────────────┐
  │  src/core.ts │  ← all logic (paths, truncation, scratchpad,
  │              │    context builder, qmd, tool functions)
  └──────┬───────┘
         │
    ┌────┴─────────────────┐
    ▼                      ▼
  ┌──────────┐   ┌──────────────┐
  │ src/     │   │ skills/      │
  │ cli.ts   │   │ ├─ claude-code/SKILL.md
  │          │   │ └─ codex/SKILL.md
  └──────────┘   └──────────────┘
   CLI binary     instruction files
   `agent-memory` that invoke CLI
```

- **`src/core.ts`**: All shared logic — paths, truncation, scratchpad, context builder, qmd integration, and standalone tool functions (`memoryWrite`, `memoryRead`, `scratchpadAction`, `memorySearch`)
- **`src/cli.ts`**: CLI entry point — `agent-memory` binary with subcommands
- **`skills/`**: SKILL.md files for Claude Code and Codex that invoke the CLI

## Commands

```bash
# Build the CLI binary
bun run build:cli

# Run unit tests (no LLM, no qmd)
bun test test/unit.test.ts
bun test test/cli.test.ts

# Install skills for Claude Code / Codex
bash scripts/install-skills.sh
```

## Key Design Patterns

- **Core + CLI**: `src/core.ts` contains all logic; `src/cli.ts` imports from it
- **Configurable paths**: `AGENT_MEMORY_DIR` env var or `--dir` flag overrides the memory directory (default: `~/.agent-memory/`)
- **Context injection**: Builds memory context (scratchpad > today > search > MEMORY.md > yesterday) for injection into system prompts
- **qmd integration**: Optional, detected at runtime. Core tools work without it, only `memory_search` and selective injection require qmd
- **After every write**: Debounced (500ms) `qmd update` runs fire-and-forget in the background
- **Scratchpad items**: Stored as markdown checklists with HTML comment metadata (`<!-- timestamp [sessionId] -->`)

## Testing

| Level | File | Requirements | What it tests |
|-------|------|-------------|---------------|
| Unit | `test/unit.test.ts` | None | Utilities, scratchpad parsing, context builder, qmd helpers, tool functions |
| CLI | `test/cli.test.ts` | None | CLI commands via core.ts imports + subprocess tests |
