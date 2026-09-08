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

The Codex installer registers a mode-independent `[[hooks.Stop]]` entry in the managed `~/.codex/config.toml` block. It invokes Core directly:

```text
agent-memory hook stop --agent codex
```

There is no adapter process or extra runtime dependency. The shared Core Stop handler owns transcript parsing, pending-signal state, retry cadence, and fail-open behavior. When Codex has uncaptured work, that handler emits Codex's native continuation response directly:

```json
{"decision":"block","reason":"<capture guidance>"}
```

Claude continues to use `hookSpecificOutput.additionalContext`; the two hosts share capture semantics without pretending their wire protocols are identical. `stop_hook_active: true` is handled in Core and produces empty stdout, so a continuation cannot immediately re-block itself. Missing, unusable, or session-mismatched transcript evidence also fails open except for the existing bounded periodic fallback.

Installation health requires the exact managed Codex SessionStart and Stop commands. Existing pre-Stop installations therefore become incomplete until `setup` / `install-hooks` repairs the managed block. `stable` mode removes only `UserPromptSubmit`; Stop remains installed because write-side capture is mode-independent. Uninstall removes the complete managed Codex hook block.

With direct installer wiring, the native Stop response, rollout parsing, and verified-write clearing all gated in CI, Codex counts as fully mechanized in the cross-harness capture evaluation.
