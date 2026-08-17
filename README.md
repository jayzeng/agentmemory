# AgentMemory

**Memory that survives the agent.** AgentMemory is a local, user-owned state layer for [Claude Code](https://claude.ai/code), [OpenAI Codex](https://github.com/openai/codex), [Cursor](https://cursor.com), and Agent (Cursor CLI). Keep scratch work, daily evidence, topic notes, and durable decisions as plain Markdown, then retrieve what matters with optional [qmd](https://github.com/tobi/qmd) search.

[![npm version](https://img.shields.io/npm/v/myagentmemory?color=cb3837&logo=npm)](https://www.npmjs.com/package/myagentmemory)
[![npm downloads](https://img.shields.io/npm/dm/myagentmemory?color=cb3837&logo=npm)](https://www.npmjs.com/package/myagentmemory)
[![license](https://img.shields.io/npm/l/myagentmemory)](LICENSE)
[![website](https://img.shields.io/badge/website-jayzeng.github.io%2Fagentmemory-0d9b7a)](https://jayzeng.github.io/agentmemory/)

[Website and quickstart](https://jayzeng.github.io/agentmemory/) · [Field report: lessons from 1,000+ coding-agent sessions](https://www.jayzeng.com/writing/agentmemory-field-report/) · [Install](#installation) · [CLI commands](#cli-commands) · [How it works](#how-it-works)

> **Field report:** “A session records what the agent did. Memory is a judgment about what the next agent should know.” Read [What 1000+ coding agent sessions taught me about LLM memory](https://www.jayzeng.com/writing/agentmemory-field-report/).

## Why AgentMemory?

Coding-agent sessions preserve activity. They do not decide which facts, decisions, and follow-ups should remain useful tomorrow. AgentMemory gives that accumulated state explicit lifetimes, a user-controlled home, and a path back into future work.

- **Different lifetimes and scopes** — route short-lived follow-ups, chronological evidence, continuing topics, and durable decisions to the right destination.
- **Curated continuity** — retain judgments that should affect future work instead of warehousing every transcript and abandoned path.
- **Plain Markdown, local-first** — read, edit, diff, back up, or delete every memory. No database, cloud service, or lock-in.
- **Optional retrieval** — skills load base context at session start and search related memories explicitly when a task needs them; qmd adds keyword, semantic, and hybrid search.
- **Shared across agents** — Claude Code, Codex, Cursor, and Agent can use the same store even as models and harnesses change.
- **Correctable state** — provenance, temporal status, secret screening, supersession, and forgetting help keep retained memory aligned with reality.

> **Naming:** `agentmemory` is the GitHub repo (and Homebrew tap), `myagentmemory` is the npm package, and `agent-memory` is the installed CLI binary. Also known as *coding agent memory* or *AI coding memory*.

### Product boundary

AgentMemory is free, open-source software under the MIT License. The core is a local Markdown store with a CLI, optional qmd search, and agent skills, and it remains fully usable without an account or commercial plugin. It does not automatically import every vendor transcript or silently decide what becomes durable. It is not a Python SDK, vector database, or knowledge graph. The Markdown files remain the source of truth.

### Optional official plugins

The MIT-licensed core can discover and host separately distributed, signed first-party plugins while remaining fully useful on its own. Optional plugins may use their own license and distribution terms; their implementation and browser assets are not part of the `myagentmemory` package. `agent-memory plugin list` and `plugin status` report local state. In an interactive terminal, `agent-memory plugin install` opens a nonce-bound loopback page for an email address, resumes the waiting command, verifies signed release metadata and the downloaded bundle, and installs atomically. The free plan uses a configurable daily agent-session allowance keyed by normalized email. D1 stores bounded activation metadata, a credential hash, and opaque SessionStart usage operations; it never receives memory, session content, queries, repository paths, raw agent session identifiers, IP addresses, or user-agent strings. Authentication and payment can extend this free activation flow later. See the [official plugin bootstrap and host contract](docs/official-plugin-bootstrap.md).

## Installation

```bash
# Homebrew (macOS)
brew tap jayzeng/agentmemory https://github.com/jayzeng/agentmemory
brew install jayzeng/agentmemory/agent-memory

# Install the portable CLI globally (Node.js 20+; macOS, Linux, or Windows)
npm install -g myagentmemory

# If corporate TLS inspection requires a private CA, use your organization's CA file:
# npm config set cafile /path/to/corporate-ca.pem

# Or build from source
bun run build:cli
# => produces dist/agent-memory

# Initialize memory directory
agent-memory init

# Install skill files for Claude Code, Codex, Cursor, and Agent
agent-memory install-skills

# Uninstall skill files
agent-memory uninstall-skills
```

The npm package installs a platform-neutral Node.js executable. The optional Homebrew and `build:cli` paths use a native binary built for the current platform.

`install-skills` writes a SKILL.md into each agent's config directory:
- `~/.claude/skills/agent-memory/SKILL.md` — Claude Code skill
- `~/.codex/skills/agent-memory/SKILL.md` — Codex skill
- `~/.cursor/skills/agent-memory/SKILL.md` — Cursor skill
- `~/.agents/skills/agent-memory/SKILL.md` — Agent CLI skill (Cursor)
- `%USERPROFILE%\.claude\skills\agent-memory\SKILL.md` — Claude Code skill (Windows)
- `%USERPROFILE%\.codex\skills\agent-memory\SKILL.md` — Codex skill (Windows)
- `%USERPROFILE%\.cursor\skills\agent-memory\SKILL.md` — Cursor skill (Windows)
- `%USERPROFILE%\.agents\skills\agent-memory\SKILL.md` — Agent CLI skill (Windows)

### Pi users

If you're on Pi and prefer a native extension, use `pi-memory` (https://github.com/jayzeng/pi-memory) instead of installing this skill. The CLI + skill workflow here is the cross-platform alternative, and works fine on Pi without any extension.

### Optional: Enable search with qmd

When qmd is installed, the collection is automatically set up via `agent-memory init`.

Note: `memory_search` **semantic**/**deep** modes require vector embeddings. If you see a warning like "need embeddings", run `qmd embed` once and retry.

If you prefer manual setup:

```bash
qmd collection add ~/.agent-memory --name agent-memory
qmd embed
```

Without qmd, all core tools (write/read/scratchpad) work normally. Only `memory_search` and selective injection require qmd.

## Memory lifecycle

AgentMemory implements a state lifecycle rather than a transcript archive. Scratch, daily, topic, and durable memory are destinations for different needs—not mandatory steps through which every entry must pass.

```
Session / external evidence
             │
             ▼
   Extract, qualify, or discard
             │
             ├── Scratch  — short-lived follow-ups
             ├── Daily    — chronological evidence
             ├── Topic    — continuing threads
             └── Durable  — curated facts and decisions
                                      │
                                      ▼
                    Retrieve · supersede · invalidate · forget
```

The files are the current implementation of this lifecycle. The durable state remains useful even if the agent, model, harness, or optional retriever changes. The [field report](https://www.jayzeng.com/writing/agentmemory-field-report/) explains the evidence and design lessons behind it.

## Repository architecture

```
  ┌───────────────┐
  │  src/core.ts  │  ← all logic: paths, truncation, scratchpad,
  └───────┬───────┘     context builder, qmd, tool functions
          │
     ┌────┴─────┐
     ▼          ▼
  ┌─────────┐   ┌─────────────────────────┐
  │ src/    │   │ skills/                 │
  │ cli.ts  │   │ ├─ claude-code/SKILL.md │
  │         │   │ ├─ codex/SKILL.md       │
  │         │   │ ├─ cursor/SKILL.md      │
  │         │   │ └─ agent/SKILL.md       │
  └─────────┘   └─────────────────────────┘
   CLI command    instruction files
  `agent-memory`  that invoke the CLI
```

The memory directory defaults to `~/.agent-memory/`. Override with `AGENT_MEMORY_DIR` env var or `--dir` flag.

## CLI Commands

| Command | Purpose |
|---------|---------|
| `agent-memory context [--query <text>] [--no-search]` | Build context and optionally include qmd matches for a query |
| `agent-memory write --target <long_term\|daily\|topic> --content <text> [--mode append\|overwrite] [--source-uri <uri>] [--topic <name>] [--date YYYY-MM-DD]` | Write to memory files with optional provenance |
| `agent-memory read --target <long_term\|scratchpad\|daily\|list\|topic\|topics> [--date YYYY-MM-DD] [--topic <name>]` | Read memory files |
| `agent-memory scratchpad <add\|done\|undo\|clear_done\|list> [--text <text>]` | Manage checklist |
| `agent-memory search --query <text> [--mode keyword\|semantic\|deep] [--limit N]` | Search via qmd |
| `agent-memory install-skills` | Install bundled SKILL.md files into local agent directories |
| `agent-memory uninstall-skills` | Uninstall bundled SKILL.md files from local agent directories |
| `agent-memory completion [bash\|zsh\|fish\|powershell] [--stdout]` | Install or print shell completion |
| `agent-memory install-hooks [--yes] [--only <agents>]` | Install managed session-start memory hooks |
| `agent-memory uninstall-hooks [--only <agents>]` | Remove only hooks managed by AgentMemory |
| `agent-memory init` | Create dirs, detect qmd, setup collection |
| `agent-memory status` | Show config, qmd status, file counts |
| `agent-memory plugin <list\|status\|install\|update\|uninstall\|manage>` | Discover and manage optional signed first-party plugins |

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
  MEMORY.md                # Curated long-term memory
  SCRATCHPAD.md            # Checklist of things to fix/remember
  daily/
    2026-02-15.md          # Daily append-only log
    2026-02-14.md
    ...
  topics/
    auth.md                # Topic/event log linked back to daily entries
```

## Topic notes

Topic files are for event- or theme-based tracking across days. Each topic entry includes a `Daily: [[YYYY-MM-DD]]` backlink so you can jump from the topic to the full daily log.

```bash
agent-memory write --target topic --topic "auth" --content "JWT refresh rolled out to edge #auth"
agent-memory read --target topic --topic "auth"
agent-memory read --target topics
```

## How it works

### Context injection

The context builder emits the following sections in priority order. Installed skills load base context at session start; callers can optionally supply `--query` to add relevant qmd results:

1. **Open scratchpad items** (up to 2K chars)
2. **Recent topic entries** (up to 2K chars) — most recent topic notes with backlinks
3. **Today's daily log** (up to 3K chars, head + tail)
4. **Relevant memories via qmd search** (up to 2.5K chars) — searches using the user's current prompt to surface related past context
5. **MEMORY.md** (up to 4K chars, middle-truncated)
6. **Yesterday's daily log** (up to 3K chars, tail — lowest priority, trimmed first)

Total output, including headings and truncation notices, is hard-capped at 16,000 characters. Explicitly untrusted, expired, superseded, revoked, or retired blocks are excluded; legacy secret-like values are redacted before injection. When qmd is unavailable, the relevant-memory step is skipped and the rest still works.

Claude Code loads base context through the skill's shell injection. Codex, Cursor, and Agent run the same base command at session start. The bundled skills use explicit search when a task relates to prior work; they make no host-level guarantee of automatic retrieval.

### Selective injection

When qmd is available and `context --query` is supplied, the CLI sanitizes the query, limits it to 200 characters, and includes the top three keyword results with the standard context. Programmatic integrations should spawn the CLI with an argument array so query text is not evaluated by a shell.

The search has a 3-second timeout and fails silently. If qmd is down or the query returns nothing, injection falls back to the standard behavior.

### Provenance, temporal state, and secret screening

`write --source-uri <uri>` stores an addressable `Source:` line with the entry. Plain-Markdown compatibility is retained: complete write entries containing standalone header metadata lines such as `Trust: untrusted`, `Status: expired`, `Status: superseded`, `Status: revoked`, or `Status: retired` are kept on disk but omitted from direct, distilled, and auto-retrieved agent context. A standalone past `Valid until: YYYY-MM-DD` line is also honored. These phrases inside ordinary prose are not treated as metadata.

Writes screen a bounded set of high-confidence credential shapes and replace matching values with `[REDACTED_SECRET]` before persistence. Context rendering applies the same screening to legacy files. This is defense in depth, not a secrets vault; avoid passing real credentials in command arguments or memory content.

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
| `AGENT_MEMORY_PLUGIN_DIR` | path | `~/.agent-memory/system/plugins` | Machine-local official plugin installation root; independent of `AGENT_MEMORY_DIR` |

## Running tests

```bash
# Unit tests (no LLM, no qmd — fast, deterministic)
bun test test/unit.test.ts
bun test test/cli.test.ts

# External-feedback dataset and deterministic capability probes
bun run build:eval
bun run test:eval
bun run eval:feedback

# Optional: add isolated live qmd multilingual retrieval probes
bun run eval:feedback --live-qmd
```

### Test levels

| Level | File | Requirements | What it tests |
|-------|------|-------------|---------------|
| Unit | `test/unit.test.ts` | None | Utilities, scratchpad parsing, context builder, qmd helpers, tool functions |
| CLI | `test/cli.test.ts` | None | CLI commands, subprocess integration |
| Feedback eval | `test/eval.test.ts`, `eval/` | qmd optional | External feedback, capability gaps, multilingual retrieval, and qualitative boundaries |

## Development

```bash
# Build the CLI binary
bun run build:cli

# Test CLI
agent-memory write --target long_term --content "test" && agent-memory read --target long_term

# Install skills
agent-memory install-skills
```

## Publishing (maintainers)

Publication is tag-driven through `.github/workflows/publish-npm.yml`. Configure `jayzeng/agentmemory` and `publish-npm.yml` as the npm trusted publisher for `myagentmemory`, merge a versioned changelog/package update, and push the matching `v<version>` tag. The workflow uses short-lived OIDC credentials, runs the complete release gate, and publishes the public package with provenance. Do not publish this package from the private plugin workspace.

### Repository assets (maintainers)

- **Social preview image:** `.github/assets/social-preview.png` (1280×640)
- **Release notes template:** `.github/release.yml` (used by GitHub auto-generated release notes)
- **Landing page source:** `docs/index.html` (deployed by `.github/workflows/deploy-pages.yml`)

## Acknowledgments

Inspired by [skyfallsin/pi-mem](https://github.com/skyfallsin/pi-mem). Semantic search is powered by [qmd](https://github.com/tobi/qmd).

## Changelog

### 0.4.12

- **Removed pi extension**: Removed `index.ts` and all pi-specific code (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@sinclair/typebox` peer dependencies).
- **Standalone tool functions**: Extracted `memoryWrite()`, `memoryRead()`, `scratchpadAction()`, `memorySearch()` into `src/core.ts` as standalone functions usable without any framework.
- **Renamed package**: `pi-memory` → `myagentmemory` (npm); the CLI binary is `agent-memory`.
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
