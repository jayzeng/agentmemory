# Codex Stop activation test plan

This slice is accepted only when CI proves all of the following:

- existing Codex SessionStart/UserPromptSubmit-only installs are treated as incomplete and upgraded with Stop;
- Stop stays installed in both `stable` and `per-turn` hook modes;
- reinstall is idempotent;
- a tampered adapter is detected and repaired;
- uninstall removes both the managed config block and adapter artifact;
- a non-empty Core Stop signal becomes Codex `decision: "block"` with a non-empty `reason`;
- empty, failed, or timed-out Core Stop evaluation fails open;
- Codex rollout completed-work detection and verified-write clearing remain green;
- cross-harness `mechanizedImmediateCoverage` is exactly 50%, with Cursor/Qoder still instruction-guided and Pi still delegated.
