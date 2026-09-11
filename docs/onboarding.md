# AgentMemory onboarding

AgentMemory is a local Markdown memory store for coding agents.

## Install and initialize

```bash
npm install -g myagentmemory
agent-memory init
agent-memory status
```

## Install agent skills

```bash
agent-memory install-skills
```

The installer only writes skill instructions for detected local agent environments.

## Try the memory flow

```bash
agent-memory write --target daily --content "Finished the cache invalidation change"
agent-memory write --target long_term --content "Cache invalidation uses versioned keys"
agent-memory context --query "cache invalidation"
agent-memory read --target long_term
```

For local search, install qmd and use `agent-memory search`.

## Storage

By default, files live under `~/.agent-memory`. Set `AGENT_MEMORY_DIR` to override the location.
