# Cross-harness capture reliability evaluation

AgentMemory can only recall a durable fact after some harness actually captures it. Retrieval quality therefore cannot stand in for capture reliability.

`npm run eval:capture` reports the current capture contract across Claude Code, Codex, Cursor, Qoder, and Pi without treating unlike integrations as equivalent.

## Enforcement classes

- **mechanized** — AgentMemory itself observes the evaluated capture opportunities and can deterministically verify the relevant path. Claude Code and Codex are in this class.
- **partially-mechanized** — at least one capture opportunity is deterministically surfaced by AgentMemory, while other important capture paths remain instruction-guided or unproven. The class remains in the schema for future integrations, but none of the currently measured harnesses use it.
- **instruction-guided** — the installed skill tells the model to capture explicit memory requests and verified outcomes, but this repository cannot deterministically prove that a model followed the instruction on a real turn.
- **delegated** — capture behavior is owned by another independently versioned package. Pi is delegated to `pi-memory`, so this repository does not count it in its measured denominator.

## Metrics

`instructionCoverage` is the fraction of locally measured harnesses whose shipped skill contains the required capture discipline: explicit memory requests are saved in-turn, write success is verified, and duplicate/routine notes are avoided.

`mechanizedExplicitRequestCoverage` measures the narrower question: for how many locally measured harnesses can AgentMemory deterministically surface an explicit user request to remember something? This is 50% (`claude` + `codex`).

`mechanizedImmediateCoverage` remains stricter. A harness only counts when AgentMemory can deterministically observe both an explicit memory request and completed work as pending capture signals. A successful AgentMemory write must also clear the signal for the fully mechanized path to pass.

Codex reaches that stricter bar through two independent surfaces: `UserPromptSubmit` injects the explicit-request capture check, while the installed `Stop` hook reads the bounded persisted rollout through the Codex parser. The Stop adapter translates AgentMemory's shared capture decision into Codex's native `decision: "block"` plus non-empty `reason` continuation protocol; an empty Core decision or adapter failure fails open.

The expected baseline is now:

- measured local harnesses: 4 (`claude`, `codex`, `cursor`, `qoder`)
- instruction coverage: 100%
- mechanized explicit-request coverage: 50% (`claude`, `codex`)
- mechanized immediate coverage: 50% (`claude`, `codex`)
- delegated harnesses: 1 (`pi` via `pi-memory`)

The stricter number moves only because CI now proves both Codex completed-work detection and verified-write clearing, and the installer tests prove the Codex Stop protocol adapter is present, idempotent, repairable, and fail-open. Future host-specific mechanisms should raise the metric only with the same kind of executable evidence.

## What this does not claim

This evaluation does not claim that every eligible fact is semantically worth saving, that a model always obeys an installed skill, or that a captured note is useful later. Those require separate behavioral/longitudinal evaluations. It also does not import `pi-memory` internals into AgentMemory; Pi should have its own equivalent capture evaluation in that repository and can later be joined through a versioned cross-repo compatibility lane.
