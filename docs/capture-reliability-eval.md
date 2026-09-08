# Cross-harness capture reliability evaluation

AgentMemory can only recall a durable fact after some harness actually captures it. Retrieval quality therefore cannot stand in for capture reliability.

`npm run eval:capture` reports the current capture contract across Claude Code, Codex, Cursor, Qoder, and Pi without treating unlike integrations as equivalent.

## Enforcement classes

- **mechanized** — AgentMemory itself observes a high-confidence capture opportunity and can deterministically verify whether a successful memory write cleared it.
- **instruction-guided** — the installed skill tells the model to capture explicit memory requests and verified outcomes, but this repository cannot deterministically prove that a model followed the instruction on a real turn.
- **delegated** — capture behavior is owned by another independently versioned package. Pi is delegated to `pi-memory`, so this repository does not count it in its measured denominator.

## Metrics

`instructionCoverage` is the fraction of locally measured harnesses whose shipped skill contains the required capture discipline: explicit memory requests are saved in-turn, write success is verified, and duplicate/routine notes are avoided.

`mechanizedImmediateCoverage` is stricter. A harness only counts when AgentMemory can deterministically observe both an explicit memory request and completed work as pending capture signals. A successful AgentMemory write must also clear the signal for the mechanized path to pass.

The initial expected baseline after the reliable Claude Stop capture check is:

- measured local harnesses: 4 (`claude`, `codex`, `cursor`, `qoder`)
- instruction coverage: 100%
- mechanized immediate coverage: 25% (`claude` only)
- delegated harnesses: 1 (`pi` via `pi-memory`)

The 25% value is not a failure of the evaluator. It is the remaining product gap made measurable. Future host-specific mechanisms should raise this number only when CI can prove the behavior, not when documentation merely claims it.

## What this does not claim

This evaluation does not claim that every eligible fact is semantically worth saving, that a model always obeys an installed skill, or that a captured note is useful later. Those require separate behavioral/longitudinal evaluations. It also does not import `pi-memory` internals into AgentMemory; Pi should have its own equivalent capture evaluation in that repository and can later be joined through a versioned cross-repo compatibility lane.
