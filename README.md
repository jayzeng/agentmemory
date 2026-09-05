# AgentMemory

**Your agent forgets everything. AgentMemory doesn't.**

Every new session with [Claude Code](https://claude.ai/code), [Codex](https://github.com/openai/codex), or [Cursor](https://cursor.com) starts cold — the decisions you made yesterday are gone, and you explain them again. AgentMemory gives your agents a persistent, local, plain-Markdown memory that survives across sessions and models.

```bash
npm install -g myagentmemory
agent-memory setup     # one-shot: memory dir, skills, hooks, MCP, local Pro preview
```

Then open your agent and ask *"what do you remember about me?"* — that's the wow.

Prefer to have an agent drive the whole thing — install, configure, verify, then show you what to do next? Feed [this onboarding doc](https://jayzeng.github.io/agentmemory/onboarding.md) to your coding agent or chat LLM and let it run the setup for you.

[![npm version](https://img.shields.io/npm/v/myagentmemory?color=cb3837&logo=npm)](https://www.npmjs.com/package/myagentmemory)
[![npm downloads](https://img.shields.io/npm/dm/myagentmemory?color=cb3837&logo=npm)](https://www.npmjs.com/package/myagentmemory)
[![license](https://img.shields.io/npm/l/myagentmemory)](LICENSE)
[![website](https://img.shields.io/badge/website-jayzeng.github.io%2Fagentmemory-0d9b7a)](https://jayzeng.github.io/agentmemory/)

[Website and quickstart](https://jayzeng.github.io/agentmemory/) · [Field report: 1,000+ coding-agent sessions](https://www.jayzeng.com/writing/agentmemory-field-report/) · [Install](#installation) · [CLI commands](#cli-commands) · [How it works](#how-it-works)

## Why AgentMemory

- AgentMemory injects your decisions, scratchpad, and daily log at session start — no copy-paste, no re-explaining.
- Repeated corrections become durable memory you can inspect and undo (Pro).
- Every memory is a plain Markdown file you own. AgentMemory's services do not receive memory content, session content, queries, or repository paths. Context you ask AgentMemory to return to a coding agent is then subject to that agent or model provider's data handling.

AgentMemory does not provide a Python SDK, does not provide a vector database, and does not provide a knowledge graph. It is a local Markdown store with a CLI, agent skills, and optional full-text and semantic search via [qmd](https://github.com/tobi/qmd). See [product boundary](docs/product-boundary.md) for full scope.

> **Field report:** "A session records what the agent did. Memory is a judgment about what the next agent should know." Read [What 1,000+ coding agent sessions taught me about LLM memory](https://www.jayzeng.com/writing/agentmemory-field-report/).

> **Naming:** `agentmemory` is the GitHub repo (and Homebrew tap), `myagentmemory` is the npm package, and `agent-memory` is the installed CLI binary. Free and MIT-licensed. See [product boundary](docs/product-boundary.md) for what it isn't.

### AgentMemory Pro preview

**Core remembers what you save. Pro learns from what you do.** Core remains free, MIT-licensed, and useful forever. Pro adds three things:

- **Remember past sessions** — ask *"what did we decide about auth?"* across Claude Code, Codex, and Pi session history. Cursor can use AgentMemory's skills and hooks, but Cursor transcript ingestion is not currently supported.
- **Learn from your patterns** — turn repeated corrections into memory you can inspect and undo.
- **Private by default** — memory and session content index locally. AgentMemory's services receive only a pseudonymous installation identifier and bounded compatibility metadata, never your memory or session content. Recall results provided locally to a coding agent are subject to that agent or model provider's data handling.

Preview what Pro would find in your existing sessions *before* installing anything:

```bash
agent-memory pro preview        # local-only scan, previews up to 50 sessions/day
agent-memory pro install        # free preview, no account required
agent-memory recall "what did we decide about authentication?"
agent-memory learn
agent-memory dashboard
```

Pre-install preview: up to 50 local sessions per day. Free installed preview: 20 recalls + 5 learning scans per local day. AgentMemory's services do not receive memory, session, query, or repository content; installation sends only a pseudonymous identifier and bounded compatibility metadata. Recall results provided locally to a coding agent are subject to that agent or model provider's data handling. Full detail on [privacy, signing, and installation](docs/official-plugin-bootstrap.md).

## Installation

```bash
# Homebrew (macOS)
brew tap jayzeng/agentmemory https://github.com/jayzeng/agentmemory
brew install jayzeng/agentmemory/agent-memory

# Install the portable Core CLI globally (Node.js 20+; Pro session recall requires Node.js 22.13+)
npm install -g myagentmemory

# If corporate TLS inspection requires a private CA, use your organization's CA file:
# npm config set cafile /path/to/corporate-ca.pem

# Or build from source
bun run build:cli
# => produces dist/agent-memory

# One-shot setup: memory dir, qmd collection, skills, hooks, MCP registration, local Pro preview
agent-memory setup

# Uninstall skill files
agent-memory uninstall-skills
```

The npm package installs a platform-neutral Node.js executable. The optional Homebrew and `build:cli` paths use a native binary built for the current platform.

`agent-memory setup` is the recommended entry point — it is idempotent, so re-running it after an upgrade or a partial install is always safe. Pass `--skip-skills`, `--skip-hooks`, `--skip-plugin`, or `--skip-mcp` to opt out of individual steps, or `--yes --json` for scripted/CI installs. If you want the older step-by-step interactive wizard instead, `agent-memory init` still works.

`install-skills` writes a SKILL.md into each agent's config directory:
- `~/.claude/skills/agent-memory/SKILL.md` — Claude Code skill
- `~/.codex/skills/agent-memory/SKILL.md` — Codex skill
- `~/.cursor/skills/agent-memory/SKILL.md` — Cursor skill
- `~/.agents/skills/agent-memory/SKILL.md` — Agent CLI skill (Cursor)
- `%USERPROFILE%\.claude\skills\agent-memory\SKILL.md` — Claude Code skill (Windows)
- `%USERPROFILE%\.codex\skills\agent-memory\SKILL.md` — Codex skill (Windows)
- `%USERPROFILE%\.cursor\skills\agent-memory\SKILL.md` — Cursor skill (Windows)
- `%USERPROFILE%\.agents\skills\agent-memory\SKILL.md` — Agent CLI skill (Windows)

### Pi

Pi doesn't use SKILL.md or a JSON hook config — its extensibility model is a registered native extension. So instead of writing a skill file, `agent-memory setup`/`install-hooks` detects `pi` on your `PATH` and installs [`pi-memory`](https://github.com/jayzeng/pi-memory) for you, via `pi install npm:pi-memory` — same author, same memory-file conventions, native pi tools (`memory_write`, `memory_read`, `scratchpad`, `memory_search`). It's prompted for like any other detected agent and auto-applied under `--yes`; run `agent-memory install-hooks --only pi` to target just pi, or check `agent-memory doctor` for its status.

### Optional: Enable search with qmd

When qmd is installed, the collection is automatically set up via `agent-memory setup` (or `init`).

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

Run `agent-memory help` for the full generated list, or `agent-memory <command> --help` for a command's flags and examples.

| Command | Purpose |
|---------|---------|
| `agent-memory setup [--yes] [--skip-skills] [--skip-hooks] [--skip-plugin] [--skip-mcp]` | One-shot idempotent installer: memory dir + skills + hooks + local Pro preview + MCP registration |
| `agent-memory context [--query <text>] [--no-search] [--layer stable\|dynamic\|full]` | Build context and optionally include qmd matches for a query |
| `agent-memory save "<text>"` | Shortcut: append a daily memory entry |
| `agent-memory note "<text>"` | Shortcut: add a scratchpad checklist item |
| `agent-memory write "<text>" --target <long_term\|daily\|topic> [--mode append\|overwrite] [--source-uri <uri>] [--topic <name>] [--date YYYY-MM-DD]` | Write to memory files with optional provenance |
| `agent-memory read --target <long_term\|scratchpad\|daily\|list\|topic\|topics> [--date YYYY-MM-DD] [--topic <name>]` | Read memory files |
| `agent-memory scratchpad <add\|done\|undo\|clear_done\|list> [--text <text>]` | Manage checklist |
| `agent-memory search --query <text> [--mode keyword\|semantic\|deep] [--limit N]` | Search indexed memory via qmd |
| `agent-memory distil [--dry-run]` | Rebuild a compact MEMORY.md index from logs and topics |
| `agent-memory sync` | Update the qmd index and semantic embeddings |
| `agent-memory install-skills [--uninstall]` | Install bundled SKILL.md files into local agent directories |
| `agent-memory uninstall-skills` | Uninstall bundled SKILL.md files from local agent directories |
| `agent-memory completion [bash\|zsh\|fish\|powershell] [--stdout]` | Install or print shell completion |
| `agent-memory install-hooks [--yes] [--all] [--only <agents>] [--mode stable\|per-turn]` | Install managed context and memory-write reminder hooks |
| `agent-memory uninstall-hooks [--only <agents>]` | Remove only hooks managed by AgentMemory |
| `agent-memory uninstall [--data] [--yes]` | Remove hooks, skills, MCP registrations, completions, and the Pro plugin; `--data` also deletes MEMORY.md, daily logs, scratchpad, and topics |
| `agent-memory init [--yes] [--skip-skills] [--skip-hooks]` | Legacy interactive wizard; `setup` runs this as its first step |
| `agent-memory status [--probe]` | Show config, qmd status, file counts, embedding health |
| `agent-memory doctor` | One-shot health check across memory, qmd, skills, hooks, and Pro |
| `agent-memory tutorial` | Guided 3-minute walkthrough in a throwaway sandbox |
| `agent-memory pro <install\|preview\|status\|upgrade\|manage>` | Install and manage the no-account AgentMemory Pro preview |
| `agent-memory recall <query>` | Recall decisions and context from prior coding sessions with Pro |
| `agent-memory learn [--preview]` | Find repeated corrections worth remembering with Pro |
| `agent-memory dashboard [--no-browser]` | Open the private local Memory Dashboard |
| `agent-memory plugin <list\|status\|install\|update\|uninstall\|manage>` | Discover and manage optional signed first-party plugins |
| `agent-memory serve --mcp [--register]` | Run as a Model Context Protocol (MCP) server over stdio |
| `agent-memory upgrade [--check] [--cli\|--plugin] [--yes]` | Check for and install newer CLI/Pro releases |
| `agent-memory version` | Print the installed version |

Global flags: `--dir <path>` (override directory), `--json` (machine output), `--help`, `--version`

With managed session-start hooks installed, AgentMemory checks for Core and Pro updates in a detached process at most once every 24 hours. New setups default to `notify`: an available Core release appears on the next session as a bordered stderr notice with the installed/latest versions, `agent-memory upgrade`, and the full release notes link. Use `agent-memory upgrade policy auto` to opt into background installation, or `agent-memory upgrade policy off` to disable update checks.

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

Supported detected hosts can receive managed automatic context hooks after `agent-memory install-hooks`; Claude Code also receives a periodic memory-write reminder. Bundled skills remain the portable fallback and use explicit search when a task relates to prior work.

`context --layer` can request a subset instead of the full six-section build: `stable` (scratchpad + topics + MEMORY.md — durable facts unlikely to change with the current prompt), `dynamic` (today's log + qmd search + yesterday's log — turn-scoped, prompt-dependent), or `full` (default, all six sections). This backs the hook system's two install modes (`install-hooks --mode stable|per-turn` / `AGENT_MEMORY_HOOK_MODE`): `per-turn` (the default) installs a SessionStart hook that loads the `stable` layer once plus a UserPromptSubmit hook that reloads the `dynamic` layer every turn; `stable` mode installs SessionStart only, loading the `full` context once per session.

### Selective injection

When qmd is available and `context --query` is supplied, the CLI sanitizes the query, limits it to 200 characters, and runs one fused `qmd` query (BM25 + vector, reciprocal-rank-fused server-side) against the current prompt, including the top three hits with the standard context. Programmatic integrations should spawn the CLI with an argument array so query text is not evaluated by a shell.

The search has an 8-second timeout and fails silently. If qmd is down or the query returns nothing, injection falls back to the standard behavior.

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
- **qmd auto-setup**: Via `agent-memory setup` (or `init`), the collection and path contexts are created automatically.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking) unless disabled via `AGENT_MEMORY_QMD_UPDATE`.
- **qmd embeddings**: Semantic/deep search needs vector embeddings. If you see "need embeddings" warnings, run `qmd embed` once and retry.
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

### Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `AGENT_MEMORY_DIR` | path | `~/.agent-memory` | Memory directory |
| `AGENT_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Controls automatic `qmd update` after writes |
| `AGENT_MEMORY_QMD_EMBED` | `background`, `manual`, `off` | `background` | Controls automatic embedding generation after `init`/`setup` |
| `AGENT_MEMORY_PLUGIN_DIR` | path | `~/.agent-memory/system/plugins` | Machine-local official plugin installation root; independent of `AGENT_MEMORY_DIR` |
| `AGENT_MEMORY_HOOK_MODE` | `stable`, `per-turn` | `per-turn` | SessionStart-only vs. SessionStart + UserPromptSubmit hook installation |
| `AGENT_MEMORY_SKILLS_ROOT` | path | auto-detected | Override where `install-skills`/`setup` look for the bundled `skills/` directory |

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

Publication is tag-driven through `.github/workflows/publish-npm.yml`. Configure the repository's `NPM_TOKEN` secret with publish access to `myagentmemory`, merge a versioned changelog/package update, and push the matching `v<version>` tag. The workflow runs the complete release gate and publishes the public package. Do not publish this package from the private plugin workspace.

### Repository assets (maintainers)

- **Social preview image:** `.github/assets/social-preview.png` (1280×640)
- **Release notes template:** `.github/release.yml` (used by GitHub auto-generated release notes)
- **Landing page source:** `docs/index.html` (deployed by `.github/workflows/deploy-pages.yml`)

## Acknowledgments

AgentMemory contains portions adapted from [pi-mem](https://github.com/jo-inc/pi-mem), used under its MIT License; the upstream copyright notice is preserved in [LICENSE](LICENSE). Semantic search is powered by [qmd](https://github.com/tobi/qmd).

## Copyright and commercial licensing

AgentMemory Core is released under the MIT License. Jay Zeng retains copyright in his original contributions and may also offer commercial products or differently licensed versions of code for which he holds the necessary rights. Existing MIT grants remain valid, and adapted upstream portions remain subject to their preserved copyright notices and license terms.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.
