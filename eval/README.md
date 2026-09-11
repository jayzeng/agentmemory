# External feedback evaluation

This suite converts public AgentMemory feedback into falsifiable probes before product fixes are proposed.

It deliberately separates three kinds of evidence:

- **Deterministic capability probes** run against isolated temporary memory directories. They cover prompt routing,
  context limits, temporal conflicts, provenance, synthetic-secret handling, untrusted content, explicit cross-agent
  handoff, transcript import, and README boundaries.
- **Live qmd retrieval probes** build an isolated qmd index and test Japanese, Chinese, cross-language, and English
  lexical controls. They use synthetic documents only and do not touch `~/.agent-memory` or the normal qmd index.
- **Qualitative observations** cover maturity and custom-skill substitution. These require longitudinal adoption or
  interview evidence and are excluded from automated scoring.

## Run

```bash
# Fast deterministic probes. Live qmd probes are reported as deferred.
bun run eval:feedback

# Include isolated live qmd keyword and semantic retrieval.
bun run eval:feedback --live-qmd

# Machine-readable report.
bun run eval:feedback --json

# Exit non-zero when any executed probe fails.
bun run eval:feedback --strict

# Dataset and runner regression tests.
bun run test:eval
```

The default command exits successfully even when a product issue is reproduced: failures are evaluation findings, not
harness crashes. Use `--strict` only when treating current requirements as a CI gate.

## Interpretation

- `failed`: the probe reproduced the claimed problem or missing capability.
- `passed`: the current implementation met that probe's requirement.
- `deferred`: the probe was not requested, currently because `--live-qmd` was omitted.

When `--live-qmd` is requested, collection, indexing, or embedding setup failures invalidate the run and exit
non-zero. They are not converted into product-probe verdicts, and a strict run cannot pass without retrieval evidence.

Issue verdicts are `confirmed`, `not-reproduced`, `mixed`, or `deferred`. A `product-opportunity` failure is not
automatically a regression; read the probe notes before converting it into a product requirement.

The corpus is synthetic and CC0-licensed. It contains no real user memory or credentials.
