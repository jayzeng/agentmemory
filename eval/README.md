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
# Fast deterministic probes against the default external-feedback dataset. Live qmd probes are reported as deferred.
bun run eval:feedback

# Expanded synthetic regression corpus (38 probes; live qmd remains opt-in)
bun run eval:feedback -- --dataset eval/datasets/agent-memory-regression-v1.json

# Run the expanded corpus with isolated live qmd retrieval
bun run eval:feedback -- --dataset eval/datasets/agent-memory-regression-v1.json --live-qmd

# Include isolated live qmd keyword and semantic retrieval.
bun run eval:feedback --live-qmd

# Machine-readable report, including retrieval quality metrics.
bun run eval:feedback --live-qmd --json

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

The live retrieval report includes Recall@1/5, MRR@1/5, nDCG@5, Precision@5, and p50/p95 latency from labeled qmd probes. Use `--dataset <path>` to select another JSON corpus, including the expanded `eval/datasets/agent-memory-regression-v1.json` dataset. Metrics are `null` when no live queries are run. A live query with no relevant result counts as an evaluated miss in Recall, MRR, and nDCG denominators; this prevents failed retrievals from disappearing from aggregate quality scores. Stale-hit rate and injected-token overhead remain explicit follow-up metrics requiring lifecycle labels and prompt-capture instrumentation.

Issue verdicts are `confirmed`, `not-reproduced`, `mixed`, or `deferred`. A `product-opportunity` failure is not
automatically a regression; read the probe notes before converting it into a product requirement.

The corpus is synthetic and CC0-licensed. It contains no real user memory or credentials.

## Token-savings simulator

`eval/token-savings.ts` is a separate, deterministic simulator that illustrates two claims across four harnesses (Claude Code, Codex, opencode, pi):

1. **Cache-regime accounting** — for cloud harnesses, memory sits in the cached prefix (Anthropic prompt cache, OpenAI `cached_tokens`); for pi, memory sits in the local runtime's KV prefix cache and its byte-stability determines whether every turn reprocesses the whole conversation.
2. **Context density** — memory delivers ~8× more context per session than a baseline preferences redeclaration, so even when raw effective tokens go up, "context chars per effective token" goes up substantially.

```bash
# Markdown table, default trace (10 sessions × 20 turns, no corrections modeled)
bun run eval:token-savings

# JSON for charting
bun run eval:token-savings --json

# Restrict to one harness
bun run eval:token-savings --harness pi

# Model correction turns memory prevents (crosses cloud harnesses into net-savings)
bun run eval:token-savings --corrections 5

# Custom trace sizes
bun run eval:token-savings --sessions 20 --turns 30 --memory-chars 6000
```

**What the simulator is not:** it does not call any LLM, and it only accounts for input tokens (not the assistant output tokens on each turn, which are priced separately per provider and typically add 20-30% to real bills). Chars-per-token and cache-read cost ratios are order-of-magnitude estimates per provider docs. Real numbers require running a recorded task through each provider's API and reading the `usage.cache_read_input_tokens` / `usage.cached_tokens` fields — see the "upgrade path" note at the top of `eval/token-savings.ts`.

**Reading the output:** for cloud harnesses at defaults (0 corrections modeled), memory increases raw effective input tokens by ~24-26% while delivering **8× more context** per session (4000 vs 500 chars) at ~6× higher context-per-effective-token density. Add `--corrections 3` for a realistic operating point where cloud harnesses cross into positive savings; `--corrections 10` shows 30-40% savings.

For **pi**, the dramatic axis is `memory-per-turn` (legacy rebuild) vs `memory-stable` (snapshot) — per-turn rebuild invalidates the KV prefix cache every turn, reprocessing the memory + all prior conversation. At long turn counts (T=80) per-turn is ~130× worse than baseline; stable stays comparable. pi requires ~11 modeled corrections before memory-stable itself saves raw tokens, because pi's cache-read cost is 0 (no discount to amplify baseline's correction cost).
