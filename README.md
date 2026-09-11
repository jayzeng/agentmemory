# AgentMemory

AgentMemory is a local-first, MIT-licensed memory layer for coding agents. It stores durable memory as plain Markdown files, keeps a daily work log and scratchpad, and can use [qmd](https://github.com/tobi/qmd) for local search.

The public project is intentionally standalone. It does not require an account, remote service, payment flow, or proprietary runtime.

## Install

```bash
npm install -g myagentmemory
agent-memory init
```

Or build from source with Bun:

```bash
bun install
bun run build:cli
```

## Core commands

```bash
agent-memory init
agent-memory context --query "what was the auth decision?"
agent-memory write --target daily --content "Implemented token refresh"
agent-memory write --target long_term --content "Auth uses rotating refresh tokens"
agent-memory read --target long_term
agent-memory scratchpad add --text "Follow up on retry policy"
agent-memory search --query "retry policy" --mode keyword
agent-memory status
agent-memory install-skills
```

Memory lives under `~/.agent-memory` by default:

```text
~/.agent-memory/
├── MEMORY.md
├── SCRATCHPAD.md
├── daily/
└── topics/
```

Set `AGENT_MEMORY_DIR` to use a different directory.

## Design principles

- **Local first.** Memory is stored on the developer's machine.
- **Plain text.** Markdown remains the source of truth.
- **Portable.** The same memory can be used from different coding-agent environments.
- **Inspectable.** Files can be read, diffed, backed up, or deleted with ordinary tools.
- **Safe by default.** Common credential shapes are redacted before AgentMemory writes or injects memory content.
- **Optional search.** qmd improves retrieval, but basic read/write behavior works without it.

## Development

```bash
npm ci
npm run check:public-boundary
npm run lint
npm run build
npm run test:unit
npm run test:cli
npm run test:eval
```

`check:public-boundary` is a release gate for this public repository. It prevents private-product coupling and known personal/private service identifiers from being added to tracked source.

## License

MIT. See `LICENSE`.
