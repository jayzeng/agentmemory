import { describe, expect, test } from "bun:test";

import {
	buildReport,
	DEFAULT_TRACE,
	getHarness,
	harnessProfiles,
	renderMarkdown,
	simulateScenario,
} from "../eval/token-savings.js";

describe("token-savings simulator", () => {
	test("all four harnesses are represented in the report", () => {
		const report = buildReport();
		const keys = report.harnesses.map((h) => h.harness).sort();
		expect(keys).toEqual(["claude-code", "codex", "opencode", "pi"]);
	});

	test("memory-stable delivers dramatically higher context density (chars per effective token)", () => {
		// Memory injects ~4000 chars vs baseline's ~500-char redeclaration — so
		// the amount of context you get per token you pay is much higher with
		// memory. This is the honest "improvement" axis, distinct from raw
		// effective-token savings which are provider-dependent.
		const report = buildReport();
		for (const h of report.harnesses) {
			const stable = h.comparisons.find((c) => c.mode === "memory-stable");
			expect(stable).toBeDefined();
			if (!stable) continue;
			expect(stable.vsBaseline.contextCharsPerEffectiveToken).toBeGreaterThan(
				stable.vsBaseline.baselineContextCharsPerEffectiveToken * 3,
			);
		}
	});

	test("pi is the only harness with a memory-per-turn scenario", () => {
		const report = buildReport();
		for (const h of report.harnesses) {
			const hasPerTurn = h.scenarios.some((s) => s.mode === "memory-per-turn");
			expect(hasPerTurn).toBe(h.harness === "pi");
		}
	});

	test("pi memory-per-turn is dramatically worse than memory-stable (KV cache invalidation)", () => {
		const pi = buildReport().harnesses.find((h) => h.harness === "pi");
		expect(pi).toBeDefined();
		if (!pi) return;
		const stable = pi.scenarios.find((s) => s.mode === "memory-stable");
		const perTurn = pi.scenarios.find((s) => s.mode === "memory-per-turn");
		expect(stable).toBeDefined();
		expect(perTurn).toBeDefined();
		if (!stable || !perTurn) return;
		// per-turn incurs KV reprocessing that stable does not — order of magnitude
		expect(perTurn.totals.effectiveInputTokens).toBeGreaterThan(stable.totals.effectiveInputTokens * 10);
		expect(perTurn.totals.kvReprocessedTokens).toBeGreaterThan(0);
		expect(stable.totals.kvReprocessedTokens).toBe(0);
	});

	test("attempting memory-per-turn on a non-pi harness throws", () => {
		expect(() => simulateScenario("claude-code", "memory-per-turn")).toThrow(/byte-stable KV prefix cache/);
		expect(() => simulateScenario("codex", "memory-per-turn")).toThrow(/byte-stable/);
		expect(() => simulateScenario("opencode", "memory-per-turn")).toThrow(/byte-stable/);
	});

	test("baseline effective cost grows with session count", () => {
		const short = simulateScenario("claude-code", "baseline", { ...DEFAULT_TRACE, sessions: 1 });
		const long = simulateScenario("claude-code", "baseline", { ...DEFAULT_TRACE, sessions: 10 });
		expect(long.totals.effectiveInputTokens).toBeGreaterThan(short.totals.effectiveInputTokens);
		expect(long.totals.effectiveInputTokens).toBeGreaterThan(short.totals.effectiveInputTokens * 5);
	});

	test("with modeled correction turns, memory-stable saves effective tokens on cloud harnesses", () => {
		// Default trace has 0 corrections, so cloud memory pays MORE raw tokens.
		// Modeling realistic corrections crosses memory over into net-savings on
		// cloud harnesses — the discounted cache-read on the memory prefix beats
		// the uncached correction turns baseline pays.
		const trace = { ...DEFAULT_TRACE, correctionTurnsPerSessionBaseline: 5 };
		const report = buildReport(trace);
		const cloud = report.harnesses.filter((h) => h.harness !== "pi");
		for (const h of cloud) {
			const stable = h.comparisons.find((c) => c.mode === "memory-stable");
			expect(stable).toBeDefined();
			if (!stable) continue;
			expect(stable.vsBaseline.effectiveTokensSaved).toBeGreaterThan(0);
		}
	});

	test("pi requires ~11 correction turns per session before memory-stable saves raw effective tokens", () => {
		// pi is self-hosted (cache-read ratio 0), so the memory injection pays
		// full price on every session open with no cache discount. Cloud
		// harnesses cross into net-savings at 3-4 corrections/session; pi's
		// crossover is much higher because there is no cache-read discount to
		// amplify baseline's correction cost.
		const belowCrossover = simulateScenario("pi", "memory-stable", {
			...DEFAULT_TRACE,
			correctionTurnsPerSessionBaseline: 10,
		});
		const belowBaseline = simulateScenario("pi", "baseline", {
			...DEFAULT_TRACE,
			correctionTurnsPerSessionBaseline: 10,
		});
		expect(belowCrossover.totals.effectiveInputTokens).toBeGreaterThan(belowBaseline.totals.effectiveInputTokens);

		const aboveCrossover = simulateScenario("pi", "memory-stable", {
			...DEFAULT_TRACE,
			correctionTurnsPerSessionBaseline: 12,
		});
		const aboveBaseline = simulateScenario("pi", "baseline", {
			...DEFAULT_TRACE,
			correctionTurnsPerSessionBaseline: 12,
		});
		expect(aboveCrossover.totals.effectiveInputTokens).toBeLessThan(aboveBaseline.totals.effectiveInputTokens);
	});

	test("Anthropic's lower cache-read ratio makes cache-heavy scenarios cheaper than OpenAI's", () => {
		const cc = simulateScenario("claude-code", "memory-stable");
		const codex = simulateScenario("codex", "memory-stable");
		expect(cc.totals.effectiveInputTokens).toBeLessThan(codex.totals.effectiveInputTokens);
	});

	test("harness profiles expose the expected metadata", () => {
		const cc = getHarness("claude-code");
		expect(cc.cacheReadCostRatio).toBeCloseTo(0.1);
		expect(cc.memoryRefresh).toBe("session-start");
		expect(cc.kvByteStablePrefix).toBe(false);

		const pi = getHarness("pi");
		expect(pi.cacheReadCostRatio).toBe(0);
		expect(pi.kvByteStablePrefix).toBe(true);
		expect(pi.memoryRefresh).toBe("stable-snapshot");

		expect(harnessProfiles()).toHaveLength(4);
	});

	test("markdown renderer produces a readable table with all rows", () => {
		const report = buildReport();
		const md = renderMarkdown(report);
		expect(md).toContain("# AgentMemory token-savings simulation");
		expect(md).toContain("Claude Code");
		expect(md).toContain("Codex (OpenAI)");
		expect(md).toContain("opencode");
		expect(md).toContain("pi (local)");
		expect(md).toContain("Context chars");
		// pi should have three data rows, others two
		const piRows = md.split("\n").filter((line) => line.startsWith("| pi (local)"));
		expect(piRows).toHaveLength(3);
		const ccRows = md.split("\n").filter((line) => line.startsWith("| Claude Code"));
		expect(ccRows).toHaveLength(2);
	});

	test("turn-by-turn accounting sums to the totals", () => {
		const scenario = simulateScenario("claude-code", "memory-stable");
		const sums = scenario.turns.reduce(
			(acc, t) => ({
				uncached: acc.uncached + t.uncachedInputTokens,
				cached: acc.cached + t.cachedReadInputTokens,
				kv: acc.kv + t.kvReprocessedTokens,
			}),
			{ uncached: 0, cached: 0, kv: 0 },
		);
		expect(sums.uncached).toBe(scenario.totals.uncachedInputTokens);
		expect(sums.cached).toBe(scenario.totals.cachedReadInputTokens);
		expect(sums.kv).toBe(scenario.totals.kvReprocessedTokens);
	});

	test("simulation is deterministic (same input → same output)", () => {
		const a = simulateScenario("codex", "memory-stable");
		const b = simulateScenario("codex", "memory-stable");
		expect(a.totals).toEqual(b.totals);
		expect(a.turns).toEqual(b.turns);
	});

	test("context chars injected scales with sessions", () => {
		const one = simulateScenario("claude-code", "memory-stable", { ...DEFAULT_TRACE, sessions: 1 });
		const ten = simulateScenario("claude-code", "memory-stable", { ...DEFAULT_TRACE, sessions: 10 });
		expect(ten.totals.contextCharsInjected).toBe(one.totals.contextCharsInjected * 10);
	});

	test("baseline correction turns extend the conversation and increase baseline effective tokens", () => {
		const noCorr = simulateScenario("claude-code", "baseline", {
			...DEFAULT_TRACE,
			correctionTurnsPerSessionBaseline: 0,
		});
		const withCorr = simulateScenario("claude-code", "baseline", {
			...DEFAULT_TRACE,
			correctionTurnsPerSessionBaseline: 5,
		});
		expect(withCorr.totals.conversationTurns).toBeGreaterThan(noCorr.totals.conversationTurns);
		expect(withCorr.totals.effectiveInputTokens).toBeGreaterThan(noCorr.totals.effectiveInputTokens);
	});
});
