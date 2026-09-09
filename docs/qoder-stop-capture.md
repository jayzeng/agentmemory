# Qoder Stop capture contract

Qoder publishes deterministic hooks and a persisted JSONL transcript for every event. AgentMemory uses those documented surfaces directly rather than relying on model compliance.

## Inputs

The managed user-level `~/.qoder/settings.json` block keeps the existing `SessionStart` context hook and adds a mode-independent `Stop` hook:

```text
agent-memory hook stop --agent qoder
```

Qoder provides `session_id`, `transcript_path`, and `stop_hook_active` to Stop. Its transcript uses `user` / `assistant` content blocks with `tool_use` and `tool_result` pairs. AgentMemory recognizes the documented native edit tools `create_file`, `search_replace`, and `edit_file`, plus compatible `Write` / `Edit` names. A failed tool result never creates a completed-work signal.

A verified `agent-memory write` / `save` executed through Qoder's `run_in_terminal` tool clears the pending signal only when the tool result is successful and contains a valid AgentMemory receipt.

## Stop control

Qoder's supported block protocol is process exit code `2` with the continuation reason on stderr. AgentMemory therefore emits no JSON adapter for Qoder: Core writes the capture guidance to stderr and sets exit code 2 only when a pending signal passes the cadence/state check. `stop_hook_active: true`, missing inputs, parser errors, and internal failures all fail open.

## Evidence basis

- Qoder hook events and Stop control: https://docs.qoder.com/cli/hooks
- Qoder IDE hook input/transcript schema and native tool names: https://docs.qoder.com/extensions/hooks

The cross-harness evaluator counts Qoder as mechanized only because CI exercises explicit requests, successful and failed native edits, the real Stop process contract, idempotent install/uninstall behavior, and verified-write clearing.
