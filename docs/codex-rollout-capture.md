# Codex rollout capture contract

AgentMemory's Claude capture check cannot be reused blindly for Codex because the persisted transcript schemas differ.

Codex Stop hooks expose `transcript_path`, which points at the persisted rollout JSONL. The capture parser recognizes only documented/persisted high-confidence records:

- `session_meta.payload.session_id` / `id` binds the file to the hook session.
- `event_msg.payload.type = user_message` supplies explicit user memory requests.
- `response_item.payload.type = custom_tool_call` / `custom_tool_call_output` represents tools such as `apply_patch`.
- `response_item.payload.type = function_call` / `function_call_output` represents function tools such as `exec_command`.

A successful `apply_patch` output is treated as completed work. A failed patch (`success: false`) is not. A later verified `agent-memory write` or `agent-memory save` command clears the pending capture signal.

The parser reads only a bounded transcript tail and returns `null` for unusable or session-mismatched files. Callers persist only the hashed signal identifier, never transcript content.

This compatibility layer does **not** by itself claim that Codex has full mechanized capture. The product metric should move from partial to fully mechanized only after the Codex installer registers a Stop hook that consumes this parser and produces a continuation prompt using Codex's supported Stop-hook control protocol.
