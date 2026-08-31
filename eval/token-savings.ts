// Token-savings simulator for AgentMemory across four harnesses.
//
// Illustrates two independent claims:
//   1. Cross-session re-explanation savings (all harnesses): with memory,
//      the user does not re-declare preferences at the start of each new
//      session. Baseline pays that cost every session.
//   2. Cache regime (harness-specific): where memory ends up in the request
//      and how the underlying cache treats it changes the effective cost:
//        - claude-code: Anthropic prompt cache (breakpoint, cached reads
//          discounted vs uncached writes).
//        - codex: OpenAI input-prefix cache (cached_tokens).
//        - opencode: downstream provider's cache (modeled as a generic
//          cloud prefix cache).
//        - pi: local runtime KV prefix cache (byte-stable). If the memory
//          bytes change turn-to-turn, the prefix cache invalidates from
//          that byte onward and every subsequent token is reprocessed —
//          the "per-turn" legacy mode. The default "stable" snapshot
//          preserves the prefix.
//
// The output is a JSON/Markdown report suitable for a chart. Numbers are
// deterministic and estimated (see docs) — the simulator does not call any
// LLM. Real numbers require running a recorded task through the real
// provider and reading usage.cache_* fields; that is the upgrade path.

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Harness profiles
// ---------------------------------------------------------------------------

export type HarnessKey = "claude-code" | "codex" | "opencode" | "pi";

export interface HarnessProfile {
	key: HarnessKey;
	label: string;
	/**
	 * Estimated characters per token for the harness's typical model family
	 * (English source). Order-of-magnitude for illustration. Anthropic and
	 * OpenAI publish ~4 chars/token for English; Llama-family tokenizers land
	 * around 3.8-4.0 chars/token.
	 */
	charsPerToken: number;
	/**
	 * Fraction of an uncached input token that a cached read costs on the
	 * provider's price sheet. Local runtimes are self-hosted; cache reads
	 * have no dollar cost, so ratio = 0. Cloud values are approximate.
	 */
	cacheReadCostRatio: number;
	/**
	 * How memory context is refreshed within a session. Determines whether
	 * the memory bytes change between turns:
	 *   - "session-start": injected once at session start; stays byte-stable
	 *     for the rest of the session.
	 *   - "stable-snapshot": injected every turn but the bytes only change
	 *     at deliberate checkpoints (pi default).
	 *   - "per-turn": injected every turn, rebuilt every turn (pi legacy).
	 */
	memoryRefresh: "session-start" | "stable-snapshot" | "per-turn";
	/**
	 * If true, the runtime keeps a byte-stable KV prefix cache. When the
	 * memory bytes change between turns, every subsequent conversation token
	 * must be reprocessed. Cloud caches use content-hashed breakpoints
	 * instead — they do not suffer this cliff.
	 */
	kvByteStablePrefix: boolean;
}

const HARNESSES: Record<HarnessKey, HarnessProfile> = {
	"claude-code": {
		key: "claude-code",
		label: "Claude Code",
		charsPerToken: 3.8,
		cacheReadCostRatio: 0.1, // Anthropic prompt cache: cached reads ~10% of write cost
		memoryRefresh: "session-start",
		kvByteStablePrefix: false,
	},
	codex: {
		key: "codex",
		label: "Codex (OpenAI)",
		charsPerToken: 4.0,
		cacheReadCostRatio: 0.5, // OpenAI input caching: cached_tokens ~50% of uncached
		memoryRefresh: "session-start",
		kvByteStablePrefix: false,
	},
	opencode: {
		key: "opencode",
		label: "opencode",
		charsPerToken: 4.0,
		cacheReadCostRatio: 0.5, // provider-average; opencode routes to many providers
		memoryRefresh: "session-start",
		kvByteStablePrefix: false,
	},
	pi: {
		key: "pi",
		label: "pi (local)",
		charsPerToken: 3.9,
		cacheReadCostRatio: 0, // self-hosted; cache reads are free
		memoryRefresh: "stable-snapshot", // pi-memory default
		kvByteStablePrefix: true,
	},
};

export function harnessProfiles(): HarnessProfile[] {
	return Object.values(HARNESSES);
}

export function getHarness(key: HarnessKey): HarnessProfile {
	return HARNESSES[key];
}

// ---------------------------------------------------------------------------
// Trace definition
// ---------------------------------------------------------------------------

export interface TraceParameters {
	/** Number of independent sessions. Baseline pays re-explanation once per session. */
	sessions: number;
	/** Turns per session. Cache benefits scale with turns per session. */
	turnsPerSession: number;
	/** Size of the memory injection in characters (typical: ~4000 = MEMORY.md cap fraction). */
	memoryChars: number;
	/**
	 * Size of the per-session preference re-declaration when no memory is
	 * available. Represents the "we use pnpm, postgres, dark theme…" opener
	 * that the user has to repeat every session.
	 */
	perSessionPrefsChars: number;
	/** Base system prompt size (harness / model / tool schemas). Same for both modes. */
	systemBaseChars: number;
	/** Average user turn characters. */
	userTurnChars: number;
	/** Average assistant turn characters. */
	assistantTurnChars: number;
	/**
	 * Extra correction turns per session in baseline mode. Represents work
	 * the user has to do to fix agent output that memory would have avoided
	 * (e.g. redoing a suggestion with the wrong package manager). Default 0
	 * — this is a speculative modeling axis, not a claim. Set explicitly to
	 * see the token-savings crossover.
	 */
	correctionTurnsPerSessionBaseline: number;
}

export const DEFAULT_TRACE: TraceParameters = {
	sessions: 10,
	turnsPerSession: 20,
	memoryChars: 4000,
	perSessionPrefsChars: 500,
	systemBaseChars: 3200,
	userTurnChars: 320,
	assistantTurnChars: 800,
	correctionTurnsPerSessionBaseline: 0,
};

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

export type Mode = "baseline" | "memory-stable" | "memory-per-turn";

export interface TurnAccounting {
	sessionIndex: number;
	turnIndex: number;
	uncachedInputTokens: number;
	cachedReadInputTokens: number;
	/** Tokens the runtime must reprocess because the KV prefix cache invalidated. */
	kvReprocessedTokens: number;
}

export interface ScenarioResult {
	harness: HarnessKey;
	mode: Mode;
	turns: TurnAccounting[];
	totals: {
		uncachedInputTokens: number;
		cachedReadInputTokens: number;
		kvReprocessedTokens: number;
		/** effectiveInputTokens = uncached + cached * cacheReadCostRatio + kvReprocessed */
		effectiveInputTokens: number;
		/**
		 * Total characters of context injected at session open across the run.
		 * Baseline: user re-declares preferences each session. Memory: the memory
		 * builder emits its capped context. This is a "what you get" axis —
		 * memory delivers dramatically more context per session.
		 */
		contextCharsInjected: number;
		/**
		 * Total conversation turns across the run (including any baseline
		 * correction turns that memory would have prevented, per trace config).
		 */
		conversationTurns: number;
	};
}

function toTokens(chars: number, charsPerToken: number): number {
	return Math.round(chars / charsPerToken);
}

function memoryPrefixTokens(profile: HarnessProfile, trace: TraceParameters, mode: Mode): number {
	if (mode === "baseline") return toTokens(trace.perSessionPrefsChars, profile.charsPerToken);
	return toTokens(trace.memoryChars, profile.charsPerToken);
}

/**
 * Simulate one scenario (harness × mode) across the trace.
 *
 * Model:
 *  - Session-open cost is charged at turn 1 (uncached), representing the
 *    system prompt + either the memory injection or the user's per-session
 *    preference redeclaration.
 *  - Subsequent turns pay: the new user turn tokens as uncached input, plus
 *    a cached read of the entire prior conversation (system + memory + all
 *    completed user/assistant turns). The provider caches those bytes; the
 *    read discount is applied via cacheReadCostRatio.
 *  - For a byte-stable KV prefix cache (pi) in "per-turn" mode, the memory
 *    bytes change between turns. Every subsequent token in the conversation
 *    from the divergence point onward must be reprocessed — modeled as
 *    kvReprocessedTokens on each turn from turn 2 to T.
 */
export function validateTrace(trace: TraceParameters): void {
	const positiveInts: Array<keyof TraceParameters> = [
		"sessions",
		"turnsPerSession",
		"memoryChars",
		"perSessionPrefsChars",
		"systemBaseChars",
		"userTurnChars",
		"assistantTurnChars",
	];
	for (const key of positiveInts) {
		const value = trace[key];
		if (!Number.isFinite(value) || value <= 0) {
			throw new Error(`trace parameter ${key} must be a positive number (got ${value})`);
		}
	}
	if (!Number.isFinite(trace.correctionTurnsPerSessionBaseline) || trace.correctionTurnsPerSessionBaseline < 0) {
		throw new Error(
			`trace parameter correctionTurnsPerSessionBaseline must be >= 0 (got ${trace.correctionTurnsPerSessionBaseline})`,
		);
	}
}

export function simulateScenario(
	harnessKey: HarnessKey,
	mode: Mode,
	trace: TraceParameters = DEFAULT_TRACE,
): ScenarioResult {
	validateTrace(trace);
	const profile = HARNESSES[harnessKey];
	if (!profile) throw new Error(`unknown harness: ${harnessKey}`);
	if (mode === "memory-per-turn" && !profile.kvByteStablePrefix) {
		throw new Error(`mode "memory-per-turn" only applies to harnesses with a byte-stable KV prefix cache (pi)`);
	}

	const sysTokens = toTokens(trace.systemBaseChars, profile.charsPerToken);
	const memTokens = memoryPrefixTokens(profile, trace, mode);
	const userTurnTokens = toTokens(trace.userTurnChars, profile.charsPerToken);
	const assistantTurnTokens = toTokens(trace.assistantTurnChars, profile.charsPerToken);
	const perTurnAddedTokens = userTurnTokens + assistantTurnTokens;

	// Baseline may include correction turns that memory would have prevented.
	const correctionTurns = mode === "baseline" ? trace.correctionTurnsPerSessionBaseline : 0;
	const turnsPerSession = trace.turnsPerSession + correctionTurns;

	const turns: TurnAccounting[] = [];

	for (let s = 0; s < trace.sessions; s++) {
		// Track how many tokens are in the "conversation history" at the
		// start of each turn (i.e. available as a cached prefix).
		let priorTurnsTokens = 0;

		for (let t = 0; t < turnsPerSession; t++) {
			let uncached = 0;
			let cached = 0;
			let kvReprocessed = 0;

			const isFirstTurn = t === 0;
			const prefixTokens = sysTokens + memTokens + priorTurnsTokens;

			if (isFirstTurn) {
				// First turn: pay the whole prefix uncached, plus the user turn.
				uncached = sysTokens + memTokens + userTurnTokens;
			} else {
				// Later turns: prefix is cached (server-side or KV), pay the new user turn uncached.
				uncached = userTurnTokens;
				cached = prefixTokens;

				// pi per-turn rebuild: memory bytes changed → the KV cache invalidates
				// from the memory injection onward. The system prompt precedes memory
				// and remains byte-stable, so its KV state stays cached. The user turn
				// of this turn is fresh input (never was in the cache), so it stays in
				// `uncached`. Everything in between — the memory prefix and the prior
				// conversation whose KV state depended on memory — must be reprocessed.
				if (mode === "memory-per-turn" && profile.kvByteStablePrefix) {
					cached = sysTokens;
					kvReprocessed = memTokens + priorTurnsTokens;
				}
			}

			turns.push({
				sessionIndex: s,
				turnIndex: t,
				uncachedInputTokens: uncached,
				cachedReadInputTokens: cached,
				kvReprocessedTokens: kvReprocessed,
			});

			// Advance conversation history: this turn's user turn + the assistant
			// response now become part of the cached prefix for the next turn.
			priorTurnsTokens += perTurnAddedTokens;
		}
	}

	const totals = turns.reduce(
		(acc, turn) => ({
			uncachedInputTokens: acc.uncachedInputTokens + turn.uncachedInputTokens,
			cachedReadInputTokens: acc.cachedReadInputTokens + turn.cachedReadInputTokens,
			kvReprocessedTokens: acc.kvReprocessedTokens + turn.kvReprocessedTokens,
			effectiveInputTokens:
				acc.effectiveInputTokens +
				turn.uncachedInputTokens +
				turn.cachedReadInputTokens * profile.cacheReadCostRatio +
				turn.kvReprocessedTokens,
		}),
		{ uncachedInputTokens: 0, cachedReadInputTokens: 0, kvReprocessedTokens: 0, effectiveInputTokens: 0 },
	);

	// Round the derived effective figure to keep JSON output tidy.
	totals.effectiveInputTokens = Math.round(totals.effectiveInputTokens);

	const contextCharsPerSession = mode === "baseline" ? trace.perSessionPrefsChars : trace.memoryChars;

	return {
		harness: harnessKey,
		mode,
		turns,
		totals: {
			...totals,
			contextCharsInjected: contextCharsPerSession * trace.sessions,
			conversationTurns: turnsPerSession * trace.sessions,
		},
	};
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface HarnessReport {
	harness: HarnessKey;
	label: string;
	profile: HarnessProfile;
	scenarios: ScenarioResult[];
	/** Comparisons vs the baseline scenario for this harness. */
	comparisons: Array<{
		mode: Mode;
		vsBaseline: {
			/** Positive = memory saves effective tokens. Negative = memory costs more. */
			effectiveTokensSaved: number;
			effectiveTokensSavedPercent: number;
			/** Positive = memory delivers more context per session. */
			contextCharsExtra: number;
			/** Density: chars of context injected per effective input token. Higher is better. */
			contextCharsPerEffectiveToken: number;
			baselineContextCharsPerEffectiveToken: number;
		};
	}>;
}

export interface Report {
	schemaVersion: "1";
	generatedAt: string;
	trace: TraceParameters;
	harnesses: HarnessReport[];
}

export function buildReport(trace: TraceParameters = DEFAULT_TRACE): Report {
	const harnesses: HarnessReport[] = harnessProfiles().map((profile) => {
		const modes: Mode[] = ["baseline", "memory-stable"];
		if (profile.kvByteStablePrefix) modes.push("memory-per-turn");
		const scenarios = modes.map((mode) => simulateScenario(profile.key, mode, trace));
		const baseline = scenarios.find((s) => s.mode === "baseline");
		if (!baseline) throw new Error("baseline scenario missing");
		const baselineDensity =
			baseline.totals.effectiveInputTokens === 0
				? 0
				: baseline.totals.contextCharsInjected / baseline.totals.effectiveInputTokens;
		const comparisons = scenarios
			.filter((s) => s.mode !== "baseline")
			.map((s) => {
				const tokensSaved = baseline.totals.effectiveInputTokens - s.totals.effectiveInputTokens;
				const tokensPct =
					baseline.totals.effectiveInputTokens === 0
						? 0
						: (tokensSaved / baseline.totals.effectiveInputTokens) * 100;
				const contextExtra = s.totals.contextCharsInjected - baseline.totals.contextCharsInjected;
				const density =
					s.totals.effectiveInputTokens === 0 ? 0 : s.totals.contextCharsInjected / s.totals.effectiveInputTokens;
				return {
					mode: s.mode,
					vsBaseline: {
						effectiveTokensSaved: tokensSaved,
						effectiveTokensSavedPercent: Number(tokensPct.toFixed(2)),
						contextCharsExtra: contextExtra,
						contextCharsPerEffectiveToken: Number(density.toFixed(3)),
						baselineContextCharsPerEffectiveToken: Number(baselineDensity.toFixed(3)),
					},
				};
			});
		return { harness: profile.key, label: profile.label, profile, scenarios, comparisons };
	});

	return {
		schemaVersion: "1",
		generatedAt: new Date().toISOString(),
		trace,
		harnesses,
	};
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

function formatMode(mode: Mode): string {
	if (mode === "baseline") return "baseline (no memory)";
	if (mode === "memory-stable") return "memory + stable snapshot";
	return "memory + per-turn rebuild (pi legacy)";
}

export function renderMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push("# AgentMemory token-savings simulation");
	lines.push("");
	lines.push(
		`Trace: ${report.trace.sessions} sessions × ${report.trace.turnsPerSession} turns/session. Memory injection ~${report.trace.memoryChars} chars. Baseline re-explanation ~${report.trace.perSessionPrefsChars} chars/session. Correction turns modeled in baseline: ${report.trace.correctionTurnsPerSessionBaseline}.`,
	);
	lines.push("");
	lines.push("## How to read this");
	lines.push("");
	lines.push(
		"**Effective input tokens** = uncached + cached-read × provider cache-read cost ratio + KV reprocessed. Lower is cheaper.",
	);
	lines.push("");
	lines.push(
		"**Context chars/effective token** = how much context you get for each effective token you pay. Higher is denser context.",
	);
	lines.push("");
	lines.push(
		"For cloud harnesses (Claude Code, Codex, opencode), memory injection is 8× the size of a baseline preferences redeclaration (4000 vs 500 chars at defaults), so raw effective tokens go up modestly — but context density delivered per effective token increases ~6× (the delivered context grows 8× while effective tokens grow ~30%). That is the honest trade: pay a bit more, get much more context and cross-session continuity.",
	);
	lines.push("");
	lines.push(
		"For **pi**, the local KV prefix cache means the dramatic story is `memory-per-turn` (legacy rebuild) vs `memory-stable` (snapshot) — per-turn rebuild reprocesses the entire conversation on every turn.",
	);
	lines.push("");
	lines.push("## Per-harness accounting");
	lines.push("");
	lines.push(
		"| Harness | Mode | Uncached | Cached-read | KV reprocessed | Effective | Context chars | Ctx/eff.tok | Effective Δ vs baseline |",
	);
	lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const h of report.harnesses) {
		for (const scenario of h.scenarios) {
			const comparison = h.comparisons.find((c) => c.mode === scenario.mode);
			const density =
				scenario.totals.effectiveInputTokens === 0
					? 0
					: scenario.totals.contextCharsInjected / scenario.totals.effectiveInputTokens;
			const deltaCell = comparison
				? `${formatNumber(comparison.vsBaseline.effectiveTokensSaved)} (${comparison.vsBaseline.effectiveTokensSavedPercent.toFixed(1)}%)`
				: "—";
			lines.push(
				`| ${h.label} | ${formatMode(scenario.mode)} | ${formatNumber(scenario.totals.uncachedInputTokens)} | ${formatNumber(scenario.totals.cachedReadInputTokens)} | ${formatNumber(scenario.totals.kvReprocessedTokens)} | ${formatNumber(scenario.totals.effectiveInputTokens)} | ${formatNumber(scenario.totals.contextCharsInjected)} | ${density.toFixed(2)} | ${deltaCell} |`,
			);
		}
	}
	lines.push("");
	lines.push("## Notes");
	lines.push("");
	lines.push(
		"- chars/token and cache-read cost ratios are order-of-magnitude estimates per provider docs (see harness profiles in `eval/token-savings.ts`).",
	);
	lines.push(
		"- Correction turns per session default to 0. Set `--corrections <n>` to model the extra work memory prevents when the agent misses preferences.",
	);
	lines.push(
		"- pi's cache-read cost ratio is 0 because it is self-hosted — the cache pays only latency, not dollars.",
	);
	lines.push(
		"- Output (assistant) tokens are not modeled. This table covers input costs only; real bills also include output tokens (typically 20-30% of total spend, priced separately per provider).",
	);
	lines.push("");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
	harness?: HarnessKey;
	json: boolean;
	md: boolean;
	sessions?: number;
	turns?: number;
	memoryChars?: number;
	prefsChars?: number;
	corrections?: number;
	out?: string;
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = { json: false, md: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") opts.json = true;
		else if (arg === "--md") opts.md = true;
		else if (arg === "--harness") opts.harness = argv[++i] as HarnessKey;
		else if (arg === "--sessions") opts.sessions = Number(argv[++i]);
		else if (arg === "--turns") opts.turns = Number(argv[++i]);
		else if (arg === "--memory-chars") opts.memoryChars = Number(argv[++i]);
		else if (arg === "--prefs-chars") opts.prefsChars = Number(argv[++i]);
		else if (arg === "--corrections") opts.corrections = Number(argv[++i]);
		else if (arg === "--out") opts.out = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			console.error(`unknown argument: ${arg}`);
			printHelp();
			process.exit(2);
		}
	}
	return opts;
}

function printHelp(): void {
	console.log(`Usage: bun eval/token-savings.ts [options]

Options:
  --harness <key>        Restrict output to one of: claude-code, codex, opencode, pi
  --sessions <n>         Number of sessions to simulate (default 10)
  --turns <n>            Turns per session (default 20)
  --memory-chars <n>     Memory injection size in chars (default 4000)
  --prefs-chars <n>      Baseline per-session re-explanation size (default 500)
  --corrections <n>      Extra correction turns per baseline session that memory
                         would prevent (default 0; try 3-5 for realistic runs)
  --json                 Emit the full JSON report
  --md                   Emit a Markdown table (default when no format flag)
  --out <path>           Write output to a file instead of stdout
  -h, --help             Show this help
`);
}

function filterReport(report: Report, harness: HarnessKey | undefined): Report {
	if (!harness) return report;
	return { ...report, harnesses: report.harnesses.filter((h) => h.harness === harness) };
}

if (import.meta.main) {
	const opts = parseArgs(process.argv.slice(2));
	const trace: TraceParameters = {
		...DEFAULT_TRACE,
		sessions: opts.sessions ?? DEFAULT_TRACE.sessions,
		turnsPerSession: opts.turns ?? DEFAULT_TRACE.turnsPerSession,
		memoryChars: opts.memoryChars ?? DEFAULT_TRACE.memoryChars,
		perSessionPrefsChars: opts.prefsChars ?? DEFAULT_TRACE.perSessionPrefsChars,
		correctionTurnsPerSessionBaseline: opts.corrections ?? DEFAULT_TRACE.correctionTurnsPerSessionBaseline,
	};
	if (opts.harness && !(opts.harness in HARNESSES)) {
		console.error(`unknown --harness: ${opts.harness}`);
		console.error(`valid: ${Object.keys(HARNESSES).join(", ")}`);
		process.exit(2);
	}
	let report: Report;
	try {
		report = filterReport(buildReport(trace), opts.harness);
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
	const rendered = opts.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
	if (opts.out) {
		fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
		fs.writeFileSync(opts.out, rendered, "utf-8");
	} else {
		process.stdout.write(rendered);
		if (!rendered.endsWith("\n")) process.stdout.write("\n");
	}
}
