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

## MCP server (`agent-memory serve --mcp`)

AgentMemory can also run as a real [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, so any MCP-capable client or coding harness can call its tools directly instead of shelling out to individual CLI commands:

```bash
agent-memory serve --mcp
```

Speaks JSON-RPC 2.0, one message per line on stdin/stdout (`initialize`, `tools/list`, `tools/call`, `ping`). Exposes five tools, each backed by the exact same logic as the CLI command of the same shape:

| Tool | Equivalent CLI command |
|---|---|
| `memory_context` | `agent-memory context` |
| `memory_search` | `agent-memory search` |
| `memory_read` | `agent-memory read` |
| `memory_write` | `agent-memory write` |
| `memory_scratchpad` | `agent-memory scratchpad` |

Try it by hand:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | agent-memory serve --mcp
```

Configure your MCP client to run `agent-memory serve --mcp` as a stdio server (exact config syntax varies by client). For a client that can't spawn a local process at all (e.g. a hosted connector like ChatGPT's), the recommended pattern is a relay: a small local client opens an outbound connection to a remote endpoint and forwards authenticated calls to this same stdio server, so memory content still never leaves your machine except as the direct result of a call you authorized. That relay is a separate, deployment-specific component (not part of this package) -- this server is the one piece every such setup should point at.

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
