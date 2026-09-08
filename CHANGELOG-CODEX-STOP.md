# Unreleased: Codex Stop capture

- Codex installs a Stop capture adapter that translates AgentMemory's shared transcript-aware capture decision into Codex's native `decision: "block"` plus `reason` continuation protocol.
- Existing Codex hook installations without Stop are treated as incomplete so setup/doctor can detect and repair them.
- Cross-harness full mechanized immediate capture coverage moves from 25% to 50% only after deterministic Codex rollout, write-clearing, installer, repair, and fail-open tests pass.
