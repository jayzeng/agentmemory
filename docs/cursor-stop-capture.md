# Cursor event-driven capture contract

Cursor exposes enough structured hook events to mechanize capture without parsing its conversation transcript format. AgentMemory therefore treats the documented event stream as the authoritative capture evidence surface for local Cursor sessions.

## Managed hooks

The user-level `~/.cursor/hooks.json` integration keeps the existing `sessionStart` context injector and adds the same Core command to five native events:

- `beforeSubmitPrompt` — records an explicit "remember this" request before the model turn starts.
- `afterFileEdit` — records successful agent file edits as completed-work evidence.
- `afterShellExecution` — clears a pending signal only when an `agent-memory write` / `save` command returns a verified receipt.
- `afterMCPExecution` — clears a pending signal only when a `memory_write` MCP call returns a verified receipt.
- `stop` — emits `{ "followup_message": "..." }` once for each uncaptured pending signal.

All five invoke:

```text
agent-memory hook cursor-event --agent cursor
```

The state machine stores only SHA-256 signal identifiers and timestamps. State is isolated into one atomically replaced file per hashed conversation ID, with seven-day / 256-session cleanup bounds; prompt text, edited file contents, and tool output are never persisted in capture state.

## Why not transcript parsing

Cursor documents `transcript_path`, but does not currently publish a transcript schema suitable for a correctness claim. The capture path therefore depends only on documented hook payloads and output fields. `afterFileEdit` itself is success evidence; write clearing additionally requires an AgentMemory receipt rather than assuming that a shell or MCP invocation succeeded.

## Stop behavior

Cursor's native Stop output is `followup_message`. AgentMemory emits it only for `status: "completed"` and only once per unchanged signal. Cursor's own `loop_count` / `loop_limit` remains an additional host-side safety bound. Aborted/error stops, missing conversation IDs, malformed state, and internal failures all fail open.

## Scope boundary

This mechanism covers local Cursor user hooks installed in `~/.cursor/hooks.json`. Cursor cloud agents do not load user-level hooks from a developer's home directory; project/team/enterprise hook distribution is a separate deployment surface and is not counted by this local evaluator.

Evidence basis: https://cursor.com/docs/hooks and https://cursor.com/docs/reference/third-party-hooks
