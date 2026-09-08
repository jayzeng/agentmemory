# Codex rollout capture contract

AgentMemory's Claude capture check cannot be reused blindly for Codex because the persisted transcript schemas and Stop output protocols differ.

Codex Stop hooks expose `transcript_path`, which points at the persisted rollout JSONL. The capture parser recognizes only documented/persisted high-confidence records:

- `session_meta.payload.session_id` / `id` binds the file to the hook session.
- `event_msg.payload.type = user_message` supplies explicit user memory requests.
- `response_item.payload.type = custom_tool_call` / `custom_tool_call_output` represents tools such as `apply_patch`.
- `response_item.payload.type = function_call` / `function_call_output` represents function tools such as `exec_command`.

A successful `apply_patch` output is treated as completed work. A failed patch (`success: false`) is not. A later verified `agent-memory write` or `agent-memory save` command clears the pending capture signal.

The parser reads only a bounded transcript tail and returns `null` for unusable or session-mismatched files. Callers persist only the hashed signal identifier, never transcript content.

## Stop activation

The Codex installer now registers `[[hooks.Stop]]` in the managed hook block and installs a small adapter under `~/.agent-memory/hooks/codex-stop.cjs`.

The adapter does not duplicate capture logic. It forwards the original Stop payload to the shared Core `agent-memory hook stop --agent codex` path. Empty Core output means Codex stops normally. A non-empty Core capture signal is translated to Codex's supported Stop control response:

```json
{"decision":"block","reason":"<capture guidance>"}
```

This preserves one transcript/state machine across Claude and Codex while adapting only the host wire protocol. `stop_hook_active` is still handled by Core, so the continuation cannot immediately re-block itself. Adapter errors, timeouts, and non-zero Core exits fail open with empty stdout.

Installation health requires both the Codex managed hook block and the exact adapter artifact. That makes existing pre-Stop installations unhealthy until `setup` / `install-hooks` repairs them, and lets `doctor` surface the same gap through its normal hook-health path.

With the installer, protocol adapter, rollout parser, and write-clearing fixtures all gated in CI, Codex counts as fully mechanized in the cross-harness capture evaluation.
