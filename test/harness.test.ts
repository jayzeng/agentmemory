/**
 * Bun test wrapper for eval/harness.ts cases.
 *
 * Cases A, C, D run unconditionally (isolated temp dirs, no external deps).
 * Case B runs with reduced N=5 samples.
 * Cases E + review mode require real memory dir — skipped in CI if absent.
 *
 * Run: bun test test/harness.test.ts --timeout 60000
 */

import { describe, expect, test } from "bun:test";
import { runHarness } from "../eval/harness.js";

describe("harness cases", () => {
	test("A: 1-shot coherence — output structure and size", async () => {
		const report = await runHarness({ latencySamples: 0 });
		const c = report.cases.find((c) => c.name === "A-oneshot-coherence");
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.errors).toEqual([]);
		expect(c.passed).toBe(true);
		expect(c.metrics.ctx_sections_count).toBeGreaterThanOrEqual(4);
		const chars = c.metrics.ctx_output_chars as number;
		expect(chars).toBeGreaterThan(500);
		expect(chars).toBeLessThanOrEqual(16_000);
	}, 30_000);

	test("B: multi-shot latency — p50 and p95 measured", async () => {
		const report = await runHarness({ latencySamples: 5 });
		const c = report.cases.find((c) => c.name === "B-multishot-latency");
		expect(c).toBeDefined();
		if (!c) return;
		if (c.metrics.skipped) {
			console.log("B: skipped —", c.metrics.skipped);
			return;
		}
		expect(c.errors).toEqual([]);
		expect(c.passed).toBe(true);
		expect(report.ctxLatP50Ms).not.toBeNull();
		expect(report.ctxLatP95Ms).not.toBeNull();
		// Generous upper bound: p95 < 5s (subprocess spawn on cold binary)
		expect(report.ctxLatP95Ms!).toBeLessThan(5_000);
	}, 60_000);

	test("C: saturation + priority — output ≤ 16000 chars, scratchpad before yesterday", async () => {
		const report = await runHarness({ latencySamples: 0 });
		const c = report.cases.find((c) => c.name === "C-saturation-priority");
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.errors).toEqual([]);
		expect(c.passed).toBe(true);
		const chars = c.metrics.ctx_output_chars as number;
		expect(chars).toBeLessThanOrEqual(16_000);
		expect(c.metrics.scratchpad_before_yesterday).toBe(1);
	}, 30_000);

	test("D: stale filtering — no stale markers in output, clean entry preserved", async () => {
		const report = await runHarness({ latencySamples: 0 });
		const c = report.cases.find((c) => c.name === "D-stale-filtering");
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.errors).toEqual([]);
		expect(c.passed).toBe(true);
		expect(report.staleHitRate).toBe(0);
		expect(c.metrics.clean_marker_present).toBe(1);
		expect(c.metrics.daily_clean_marker_present).toBe(1);
	}, 30_000);

	test("E: injected token overhead — measured from real memory dir", async () => {
		const report = await runHarness({ latencySamples: 0 });
		const c = report.cases.find((c) => c.name === "E-token-overhead");
		expect(c).toBeDefined();
		if (!c) return;
		if (c.metrics.skipped) {
			console.log("E: skipped —", c.metrics.skipped);
			return;
		}
		expect(c.errors).toEqual([]);
		expect(c.passed).toBe(true);
		expect(report.injectedTokenOverhead).not.toBeNull();
		expect(report.injectedTokenOverhead!).toBeGreaterThan(0);
		// Real context should be under 4096 tokens (16384 chars / 4)
		expect(report.injectedTokenOverhead!).toBeLessThanOrEqual(4_096);
	}, 15_000);
});
