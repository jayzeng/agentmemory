# Codex Stop activation test plan

This slice is accepted only when CI proves all of the following:

- existing Codex SessionStart/UserPromptSubmit-only installs are treated as incomplete and upgraded with Stop;
- Stop stays installed in both `stable` and `per-turn` hook modes;
- reinstall is idempotent;
- uninstall removes the complete managed Codex hook block;
- the installed Stop command invokes Core directly with `agent-memory hook stop --agent codex`;
- a real Codex rollout containing successful `apply_patch` work makes the real Core Stop path emit `decision: "block"` with a non-empty `reason`;
- the same unchanged pending signal does not immediately re-block, and `stop_hook_active: true` always emits nothing;
- a verified AgentMemory write clears the pending Codex capture signal;
- failed, unusable, or session-mismatched transcript evidence fails open;
- Codex rollout completed-work detection and verified-write clearing remain green;
- cross-harness `mechanizedImmediateCoverage` is exactly 50%, with Cursor/Qoder still instruction-guided and Pi still delegated.
