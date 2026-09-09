# Longitudinal behavior evaluation

AgentMemory already has retrieval and capture evaluations, but those do not answer the downstream question: after a decision, correction, or preference is stored, does later behavior improve without introducing stale-memory harm?

`npm run eval:longitudinal-behavior` adds a paired, deterministic contract benchmark for that layer.

## What is measured

Each scenario contains an earlier multi-session memory history plus a later task. The same later task is scored under three arms:

1. **memory** — the complete history is written into an isolated AgentMemory directory and passed through the real `buildMemoryContext` lifecycle/trust filtering path;
2. **no-memory control** — the downstream policy receives no memory context;
3. **stale-only control** — only inactive history (`superseded`, `retired`, `expired`, or `untrusted`) is present and still passes through AgentMemory's real context filter.

The fixture set currently contains 21 later-session probes spanning correction reuse, durable decision reuse, preference reuse, stale-memory resistance (which also covers untrusted-memory scenarios), and irrelevant-memory resistance.

## Reference policy

CI uses a deliberately small deterministic policy, `cue-match-v1`. Candidate actions declare explicit memory cues. The unique candidate with the most matching cues wins; no evidence or a tie falls back to the declared default action.

This policy is not intended to imitate an LLM. It exists to make the downstream memory contract executable and reproducible: if AgentMemory surfaces the right active fact, the later action changes predictably; if it leaks stale or irrelevant memory, the harm metrics change predictably.

The JSON report therefore declares:

```json
{
  "claims": {
    "deterministicContract": true,
    "liveModelEffectMeasured": false
  }
}
```

A future live-agent lane can reuse the same dataset and report schema, but must not overwrite or blur this distinction.

## Metrics

- `memorySuccessRate` and `controlSuccessRate` — weighted success across all later probe sessions.
- `absoluteSuccessLift` — paired memory success minus no-memory success.
- `helpfulMemorySuccessRate` / `helpfulControlSuccessRate` — success only where the stored memory is supposed to change the action.
- `memoryRepeatedErrorRate` / `controlRepeatedErrorRate` — later-session error rates on the helpful scenarios.
- `repeatedErrorReduction` — absolute reduction in repeated error rate from the no-memory control to the memory arm.
- `correctionReuseRate` — later-session success on scenarios where a newer correction supersedes an older fact.
- `staleActionRate` — frequency with which the stale-only arm selects the explicitly stale action.
- `inappropriateRecallRate` — frequency with which stale/untrusted/irrelevant memory changes an action that should remain at its default.

The initial deterministic gate requires: at least 20 total probe sessions, 100% helpful-memory success, 0% helpful-control success, memory success strictly better than control success, 100% correction reuse, 0% stale-action selection, 0% inappropriate recall, and a full reduction of the repeated-error rate in this synthetic contract corpus.

## What this proves

It proves that, for this controlled corpus, AgentMemory's persisted context can carry active corrections/decisions/preferences across later sessions while its lifecycle/trust filtering prevents the defined stale and untrusted evidence from changing the downstream reference action. It also proves the benchmark itself has a paired no-memory baseline instead of reporting memory-arm accuracy in isolation.

## What this does not prove

It does **not** prove a production LLM will achieve the same effect size, that every captured memory is useful, that qmd retrieval quality is perfect, or that a real agent will obey every surfaced fact. Those require live-model experiments with repeated trials, pinned model/version/temperature, confidence intervals, and cost/latency accounting.

LongMemEval-S remains the retrieval benchmark; the cross-harness capture evaluation remains the capture benchmark. This evaluation is intentionally the downstream deterministic behavior-contract layer between those infrastructure checks and a future live-agent longitudinal study.
