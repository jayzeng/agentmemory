# agent-memory

Persistent memory for coding agents — [Claude Code](https://claude.ai/code) and [OpenAI Codex](https://github.com/openai/codex). Semantic search powered by [qmd](https://github.com/tobi/qmd).

Thanks to https://github.com/skyfallsin/pi-mem for inspiration.

Long-term facts, daily logs, and a scratchpad checklist stored as plain markdown files. Optional qmd integration adds keyword, semantic, and hybrid search across all memory files, plus automatic selective injection of relevant past memories into every turn.

## Installation

```bash
# Install the CLI globally
npm install -g agent-memory

# Or build from source
bun run build:cli
# => produces dist/agent-memory

# Initialize memory directory
agent-memory init

# Install skill files for Claude Code and Codex
bash scripts/install-skills.sh
pwsh -File scripts/install-skills.ps1
```

This installs:
- `~/.claude/skills/agent-memory/SKILL.md` — Claude Code skill
- `~/.codex/skills/agent-memory/SKILL.md` — Codex skill
- `%USERPROFILE%\.claude\skills\agent-memory\SKILL.md` — Claude Code skill (Windows)
- `%USERPROFILE%\.codex\skills\agent-memory\SKILL.md` — Codex skill (Windows)

### Optional: Enable search with qmd

When qmd is installed, the collection is automatically set up via `agent-memory init`.

Note: `memory_search` **semantic**/**deep** modes require vector embeddings. If you see a warning like "need embeddings", run `qmd embed` once and retry.

If you prefer manual setup:

```bash
qmd collection add ~/.agent-memory --name agent-memory
qmd embed
```

Without qmd, all core tools (write/read/scratchpad) work normally. Only `memory_search` and selective injection require qmd.

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

The memory directory defaults to `~/.agent-memory/`. Override with `AGENT_MEMORY_DIR` env var or `--dir` flag.

## CLI Commands

| Command | Purpose |
|---------|---------|
| `agent-memory context [--no-search]` | Build & print context injection string to stdout |
| `agent-memory write --target <long_term\|daily> --content <text> [--mode append\|overwrite]` | Write to memory files |
| `agent-memory read --target <long_term\|scratchpad\|daily\|list> [--date YYYY-MM-DD]` | Read memory files |
| `agent-memory scratchpad <add\|done\|undo\|clear_done\|list> [--text <text>]` | Manage checklist |
| `agent-memory search --query <text> [--mode keyword\|semantic\|deep] [--limit N]` | Search via qmd |
| `agent-memory init` | Create dirs, detect qmd, setup collection |
| `agent-memory status` | Show config, qmd status, file counts |

Global flags: `--dir <path>` (override directory), `--json` (machine output)

### memory_search modes

| Mode | Speed | Method | Best for |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names, #tags, [[links]] |
| `semantic` | ~2s | Vector search | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | When other modes miss |

If the first search doesn't find what you need, try rephrasing or switching modes.

## File layout

```
~/.agent-memory/
  MEMORY.md              # Curated long-term memory
  SCRATCHPAD.md           # Checklist of things to fix/remember
  daily/
    2026-02-15.md         # Daily append-only log
    2026-02-14.md
    ...
```

## How it works

### Context injection

Before every agent turn, the following are injected into the system prompt (in priority order):

1. **Open scratchpad items** (up to 2K chars)
2. **Today's daily log** (up to 3K chars, tail)
3. **Relevant memories via qmd search** (up to 2.5K chars) — searches using the user's current prompt to surface related past context
4. **MEMORY.md** (up to 4K chars, middle-truncated)
5. **Yesterday's daily log** (up to 3K chars, tail — lowest priority, trimmed first)

Total injection is capped at 16K chars. When qmd is unavailable, step 3 is skipped and the rest works as before.

For Claude Code, context is injected via the `!`agent-memory context`` syntax in the SKILL.md. For Codex, the agent runs `agent-memory context` at session start.

### Selective injection

When qmd is available, the system automatically searches memory using the user's prompt on demand (CLI). The top 3 keyword results are injected alongside the standard context.

The search has a 3-second timeout and fails silently. If qmd is down or the query returns nothing, injection falls back to the standard behavior.

### Tags and links

Use `#tags` and `[[wiki-links]]` in memory content to improve searchability:

```markdown
#decision [[database-choice]] Chose PostgreSQL for all backend services.
#preference [[editor]] User prefers Neovim with LazyVim config.
#lesson [[api-versioning]] URL prefix versioning (/v1/) avoids CDN cache issues.
```

These are content conventions, not enforced metadata. qmd's full-text indexing makes them searchable for free.

### Other behavior

- **Persistence**: Memory files are plain markdown on disk — readable, editable, and git-friendly.
- **Tool response previews**: Write/scratchpad tools return size-capped previews instead of full file contents.
- **qmd auto-setup**: Via `agent-memory init`, the collection and path contexts are created automatically.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking) unless disabled via `AGENT_MEMORY_QMD_UPDATE`.
- **qmd embeddings**: Semantic/deep search needs vector embeddings. If you see "need embeddings" warnings, run `qmd embed` once and retry.
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

### Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `AGENT_MEMORY_DIR` | path | `~/.agent-memory` | Memory directory |
| `AGENT_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Controls automatic `qmd update` after writes |

## Running tests

```bash
# Unit tests (no LLM, no qmd — fast, deterministic)
bun test test/unit.test.ts
bun test test/cli.test.ts
```

### Test levels

| Level | File | Requirements | What it tests |
|-------|------|-------------|---------------|
| Unit | `test/unit.test.ts` | None | Utilities, scratchpad parsing, context builder, qmd helpers, tool functions |
| CLI | `test/cli.test.ts` | None | CLI commands, subprocess integration |

## Development

```bash
# Build the CLI binary
bun run build:cli

# Test CLI
agent-memory write --target long_term --content "test" && agent-memory read --target long_term

# Install skills
bash scripts/install-skills.sh
pwsh -File scripts/install-skills.ps1
```

## Publishing (maintainers)

```bash
# Confirm package name is available
npm view agent-memory

# Bump version (choose patch/minor/major)
npm version patch

# Publish to npm (public)
npm publish --access public
```

## Changelog

### 0.5.0

- **Removed pi extension**: Removed `index.ts` and all pi-specific code (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@sinclair/typebox` peer dependencies).
- **Standalone tool functions**: Extracted `memoryWrite()`, `memoryRead()`, `scratchpadAction()`, `memorySearch()` into `src/core.ts` as standalone functions usable without any framework.
- **Renamed package**: `pi-memory` → `agent-memory`.
- **Renamed env var**: `PI_MEMORY_QMD_UPDATE` → `AGENT_MEMORY_QMD_UPDATE` (old name still works as fallback).
- **Default memory directory**: Now always `~/.agent-memory/`.
- **Removed pi-specific tests**: Deleted `test/e2e.ts`, `test/eval-recall.ts`, `test/unit.ts`.

### 0.4.0

- **Multi-platform support**: Memory system now works with Claude Code and OpenAI Codex via CLI + skills, in addition to pi.
- **Extracted shared core**: `src/core.ts` contains platform-agnostic logic (paths, truncation, scratchpad, context builder, qmd) with zero pi peer dependencies.
- **CLI binary**: `agent-memory` CLI with subcommands: `context`, `write`, `read`, `scratchpad`, `search`, `init`, `status`.
- **Skill files**: `skills/claude-code/SKILL.md` and `skills/codex/SKILL.md` for installation into respective platforms.
- **Configurable memory directory**: `AGENT_MEMORY_DIR` env var or `--dir` flag (default: `~/.agent-memory/`).
- **CLI tests**: `test/cli.test.ts` with unit and subprocess tests.

### 0.2.0

- **Selective injection**: Before each turn, the user's prompt is searched against memory via qmd. Top results are injected into the system prompt alongside standard context, surfacing relevant past decisions without explicit tool calls.
- **qmd auto-setup**: The extension automatically creates the collection and path contexts on session start when qmd is available. No manual `qmd collection add` needed.
- **Tags and links**: `memory_write` and context injection now encourage `#tags` and `[[wiki-links]]` as searchable content conventions.
- **Context priority reordering**: Injection order is now scratchpad > today > search results > MEMORY.md > yesterday.
- **Unit tests**: Added deterministic tests (no LLM/qmd needed).
- **Recall eval**: Added recall effectiveness evaluation.

### 0.1.0

- Initial release: `memory_write`, `memory_read`, `scratchpad`, `memory_search` tools.
- Context injection of MEMORY.md, scratchpad, and today/yesterday daily logs.
- qmd integration for keyword, semantic, and hybrid search.
- Debounced background `qmd update` after writes.
