/**
 * End-to-end harness for agent-memory.
 *
 * Modes:
 *   bun eval/harness.ts [--json]           run harness cases A-E
 *   bun eval/harness.ts --review [--json]  replay recent agent sessions
 *
 * Always uses the compiled binary at ./dist/agent-memory.
 * Write tests use an isolated AGENT_MEMORY_DIR temp dir.
 * Latency/review tests use the real ~/.agent-memory dir.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	_clearUpdateTimer,
	_resetBaseDir,
	_setBaseDir,
	_setQmdAvailable,
	dailyPath,
	ensureDirs,
	getMemoryFile,
	getScratchpadFile,
	todayStr,
	yesterdayStr,
} from "../src/core.js";
import type { HarnessCase, HarnessReport, SessionReviewResult } from "./types.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BINARY = path.join(REPO_ROOT, "dist", "agent-memory");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[idx];
}

function countSections(output: string): number {
	return (output.match(/^## /gm) ?? []).length;
}

/** Run the compiled binary in a subprocess, return stdout. */
function runBinary(
	args: string[],
	env: NodeJS.ProcessEnv = {},
	timeoutMs = 10_000,
): { stdout: string; stderr: string; status: number | null; durationMs: number } {
	const start = performance.now();
	const result = spawnSync(BINARY, args, {
		encoding: "utf-8",
		env: { ...process.env, AGENT_MEMORY_QMD_UPDATE: "off", ...env },
		timeout: timeoutMs,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
		durationMs: performance.now() - start,
	};
}

/** Set up an isolated temp dir, run fn(), tear down. Returns fn result. */
function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-harness-"));
	_setBaseDir(dir);
	_setQmdAvailable(false);
	ensureDirs();
	try {
		return fn(dir);
	} finally {
		_clearUpdateTimer();
		_resetBaseDir();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Case A — 1-shot coherence
// ---------------------------------------------------------------------------

function caseA(): HarnessCase {
	const errors: string[] = [];
	const metrics: Record<string, number | string | null> = {};

	const result = withTempDir((dir) => {
		// Populate memory with one entry in each section type
		const today = todayStr();
		const yesterday = yesterdayStr();

		fs.writeFileSync(
			getScratchpadFile(),
			`<!-- ${today} 10:00:00 [test-session] -->\n- [ ] Review deploy plan\n`,
			"utf-8",
		);
		fs.writeFileSync(
			dailyPath(today),
			`<!-- ${today} 09:00:00 [test-session] -->\nFixed the scheduler timeout bug — root cause was a missing backoff in retry loop.\n\n<!-- ${today} 09:30:00 [test-session] -->\nUpdated the example booking client to the v1/reservations endpoint. #booking\n`,
			"utf-8",
		);
		fs.writeFileSync(
			dailyPath(yesterday),
			`<!-- ${yesterday} 17:00:00 [test-session] -->\nCompleted initial capacity analysis for the fictional Northstar service portfolio. #capacity\n`,
			"utf-8",
		);

		const topicDir = path.join(dir, "topics");
		fs.writeFileSync(
			path.join(topicDir, "example-check-in.md"),
			`# Topic: example-check-in\n\nThe fictional Northstar check-in workflow stores reservation state in its demo database.\n`,
			"utf-8",
		);
		fs.writeFileSync(
			path.join(topicDir, "scheduler.md"),
			`# Topic: scheduler\n\nFictional Northstar scheduling modernization initiative.\n`,
			"utf-8",
		);

		fs.writeFileSync(
			getMemoryFile(),
			`<!-- ${today} 08:00:00 [test-session] -->\nUser is Casey Example, engineering lead at Example Co. Focus: scheduling modernization and capacity planning.\n`,
			"utf-8",
		);

		const { stdout, status, durationMs } = runBinary(["context"], { AGENT_MEMORY_DIR: dir });

		return { stdout, status, durationMs, dir };
	});

	metrics.ctx_latency_ms = Math.round(result.durationMs);
	metrics.ctx_output_chars = result.stdout.length;
	metrics.ctx_estimated_tokens = Math.ceil(result.stdout.length / 4);
	metrics.ctx_sections_count = countSections(result.stdout);

	if (result.status !== 0) errors.push(`binary exited ${result.status}`);
	if (!result.stdout.startsWith("# Memory")) errors.push("output does not start with '# Memory'");
	if (metrics.ctx_sections_count < 4) errors.push(`only ${metrics.ctx_sections_count} sections — expected ≥ 4`);
	if ((metrics.ctx_output_chars as number) < 500) errors.push(`output too short: ${metrics.ctx_output_chars} chars`);
	if ((metrics.ctx_output_chars as number) > 16_000)
		errors.push(`output exceeds 16000 chars: ${metrics.ctx_output_chars}`);

	return {
		name: "A-oneshot-coherence",
		passed: errors.length === 0,
		durationMs: Math.round(result.durationMs),
		metrics,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Case B — multi-shot latency
// ---------------------------------------------------------------------------

function caseB(n = 20): HarnessCase {
	const errors: string[] = [];
	const metrics: Record<string, number | string | null> = {};

	const realMemoryDir = process.env.AGENT_MEMORY_DIR ?? path.join(os.homedir(), ".agent-memory");

	if (!fs.existsSync(realMemoryDir)) {
		return {
			name: "B-multishot-latency",
			passed: false,
			durationMs: 0,
			metrics: { skipped: "real memory dir not found" },
			errors: [`real memory dir ${realMemoryDir} does not exist`],
		};
	}

	const warmup = Math.min(5, Math.floor(n / 4));
	const latencies: number[] = [];

	for (let i = 0; i < warmup + n; i++) {
		const { durationMs } = runBinary(["context"], { AGENT_MEMORY_DIR: realMemoryDir });
		if (i >= warmup) latencies.push(durationMs);
	}

	const sorted = [...latencies].sort((a, b) => a - b);
	metrics.ctx_lat_p50_ms = Math.round(percentile(sorted, 50));
	metrics.ctx_lat_p95_ms = Math.round(percentile(sorted, 95));
	metrics.ctx_lat_max_ms = Math.round(sorted[sorted.length - 1]);
	metrics.ctx_lat_min_ms = Math.round(sorted[0]);
	metrics.samples = n;

	return {
		name: "B-multishot-latency",
		passed: errors.length === 0,
		durationMs: Math.round(latencies.reduce((a, b) => a + b, 0)),
		metrics,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Case C — saturation + priority ordering
// ---------------------------------------------------------------------------

function caseC(): HarnessCase {
	const errors: string[] = [];
	const metrics: Record<string, number | string | null> = {};

	// Section budgets from core.ts (kept in sync manually)
	const SCRATCHPAD_BUDGET = 2_000;
	const _MEMORY_BUDGET = 4_000;
	const CONTEXT_MAX = 16_000;

	const result = withTempDir((dir) => {
		const today = todayStr();
		const yesterday = yesterdayStr();
		const pad = (n: number, char = "x") => char.repeat(n);

		// Overflow scratchpad (write 4KB)
		const scratchpadItems = Array.from(
			{ length: 50 },
			(_, i) => `<!-- ${today} ${String(i).padStart(2, "0")}:00:00 [s] -->\n- [ ] Task ${i}: ${pad(60)}\n`,
		).join("\n");
		fs.writeFileSync(getScratchpadFile(), scratchpadItems, "utf-8");

		// Overflow today daily (write 6KB)
		const todayEntries = Array.from(
			{ length: 30 },
			(_, i) => `<!-- ${today} ${String(i).padStart(2, "0")}:01:00 [s] -->\nDaily entry ${i}: ${pad(180)}\n`,
		).join("\n");
		fs.writeFileSync(dailyPath(today), todayEntries, "utf-8");

		// Overflow MEMORY.md (write 8KB)
		fs.writeFileSync(getMemoryFile(), `<!-- ${today} 00:00:00 [s] -->\n${pad(8_000)}\n`, "utf-8");

		// Overflow yesterday daily (write 6KB)
		const yesterdayEntries = Array.from(
			{ length: 30 },
			(_, i) => `<!-- ${yesterday} ${String(i).padStart(2, "0")}:01:00 [s] -->\nYesterday entry ${i}: ${pad(180)}\n`,
		).join("\n");
		fs.writeFileSync(dailyPath(yesterday), yesterdayEntries, "utf-8");

		// 10 topics (overflow)
		const topicDir = path.join(dir, "topics");
		for (let i = 0; i < 10; i++) {
			fs.writeFileSync(path.join(topicDir, `topic-${i}.md`), `# Topic: topic-${i}\n\n${pad(300)}\n`, "utf-8");
		}

		const { stdout, status, durationMs } = runBinary(["context"], { AGENT_MEMORY_DIR: dir });
		return { stdout, status, durationMs };
	});

	metrics.ctx_output_chars = result.stdout.length;
	metrics.ctx_sections_count = countSections(result.stdout);

	const scratchpadMatch = result.stdout.match(/## SCRATCHPAD\.md[\s\S]*?(?=\n---\n|$)/);
	const _yesterdayMatch = result.stdout.match(/## Daily log:.*\(yesterday\)[\s\S]*?(?=\n---\n|$)/);

	const scratchpadSection = scratchpadMatch?.[0] ?? "";
	metrics.scratchpad_section_chars = scratchpadSection.length;

	if (result.status !== 0) errors.push(`binary exited ${result.status}`);
	if ((metrics.ctx_output_chars as number) > CONTEXT_MAX)
		errors.push(`output ${metrics.ctx_output_chars} exceeds CONTEXT_MAX ${CONTEXT_MAX}`);
	if ((metrics.scratchpad_section_chars as number) > SCRATCHPAD_BUDGET + 200)
		errors.push(
			`scratchpad section ${metrics.scratchpad_section_chars} chars exceeds budget ${SCRATCHPAD_BUDGET} by too much`,
		);

	// Priority: scratchpad heading must appear before yesterday heading
	const scratchpadIdx = result.stdout.indexOf("## SCRATCHPAD.md");
	const _yesterdayIdx = result.stdout.indexOf("## Daily log:");
	const yesterdayDayIdx = result.stdout.lastIndexOf("(yesterday)");
	if (scratchpadIdx === -1) {
		errors.push("scratchpad section missing from saturated output");
	} else if (yesterdayDayIdx !== -1 && scratchpadIdx > yesterdayDayIdx) {
		errors.push("priority violated: yesterday section appears before scratchpad section");
	}

	metrics.scratchpad_before_yesterday =
		scratchpadIdx !== -1 && (yesterdayDayIdx === -1 || scratchpadIdx < yesterdayDayIdx) ? 1 : 0;
	metrics.ctx_truncation_triggered = (metrics.ctx_output_chars as number) < 2_000 ? 0 : 1;

	return {
		name: "C-saturation-priority",
		passed: errors.length === 0,
		durationMs: 0,
		metrics,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Case D — stale entry filtering
// ---------------------------------------------------------------------------

function caseD(): HarnessCase {
	const errors: string[] = [];
	const metrics: Record<string, number | string | null> = {};

	const result = withTempDir((dir) => {
		const today = todayStr();

		// Write stale entries to MEMORY.md using all three lifecycle markers
		fs.writeFileSync(
			getMemoryFile(),
			[
				`<!-- ${today} 01:00:00 [s] -->`,
				"## Stale entry 1 — superseded",
				"Status: superseded",
				"",
				"This content should not appear.",
				"STALE_SUPERSEDED_MARKER",
				"",
				`<!-- ${today} 02:00:00 [s] -->`,
				"## Stale entry 2 — expired lifecycle",
				"Status: expired",
				"",
				"STALE_EXPIRED_MARKER",
				"",
				`<!-- ${today} 03:00:00 [s] -->`,
				"## Stale entry 3 — untrusted source",
				"Trust: untrusted",
				"",
				"STALE_UNTRUSTED_MARKER",
				"",
				`<!-- ${today} 04:00:00 [s] -->`,
				"## Clean entry — should appear",
				"",
				"CLEAN_CONTENT_MARKER — This is trusted active memory.",
			].join("\n"),
			"utf-8",
		);

		// Also write a stale daily entry
		fs.writeFileSync(
			dailyPath(today),
			[
				`<!-- ${today} 05:00:00 [s] -->`,
				"Status: revoked",
				"",
				"DAILY_STALE_REVOKED_MARKER",
				"",
				`<!-- ${today} 06:00:00 [s] -->`,
				"Active daily log entry. DAILY_CLEAN_MARKER",
			].join("\n"),
			"utf-8",
		);

		const { stdout, status, durationMs } = runBinary(["context"], { AGENT_MEMORY_DIR: dir });
		return { stdout, status, durationMs };
	});

	const staleMarkers = [
		"STALE_SUPERSEDED_MARKER",
		"STALE_EXPIRED_MARKER",
		"STALE_UNTRUSTED_MARKER",
		"DAILY_STALE_REVOKED_MARKER",
	];
	const foundStale = staleMarkers.filter((m) => result.stdout.includes(m));
	const staleHitRate = foundStale.length / staleMarkers.length;

	metrics.stale_hit_rate = staleHitRate;
	metrics.stale_markers_found = foundStale.length;
	metrics.stale_markers_total = staleMarkers.length;
	metrics.clean_marker_present = result.stdout.includes("CLEAN_CONTENT_MARKER") ? 1 : 0;
	metrics.daily_clean_marker_present = result.stdout.includes("DAILY_CLEAN_MARKER") ? 1 : 0;

	if (result.status !== 0) errors.push(`binary exited ${result.status}`);
	if (staleHitRate > 0) errors.push(`stale entries leaked into output: ${foundStale.join(", ")}`);
	if (!result.stdout.includes("CLEAN_CONTENT_MARKER"))
		errors.push("clean entry was incorrectly filtered — context is over-pruning");
	if (!result.stdout.includes("DAILY_CLEAN_MARKER")) errors.push("clean daily entry was incorrectly filtered");

	return {
		name: "D-stale-filtering",
		passed: errors.length === 0,
		durationMs: 0,
		metrics,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Case E — injected token overhead
// ---------------------------------------------------------------------------

function caseE(): HarnessCase {
	const errors: string[] = [];
	const metrics: Record<string, number | string | null> = {};

	const realMemoryDir = process.env.AGENT_MEMORY_DIR ?? path.join(os.homedir(), ".agent-memory");

	if (!fs.existsSync(realMemoryDir)) {
		return {
			name: "E-token-overhead",
			passed: true,
			durationMs: 0,
			metrics: { skipped: "real memory dir not found — using 0" },
			errors: [],
		};
	}

	const { stdout, status, durationMs } = runBinary(["context"], { AGENT_MEMORY_DIR: realMemoryDir });
	if (status === 0 && stdout.length === 0) {
		return {
			name: "E-token-overhead",
			passed: true,
			durationMs: Math.round(durationMs),
			metrics: { skipped: "real memory dir has no injectable context" },
			errors: [],
		};
	}

	metrics.ctx_output_chars = stdout.length;
	metrics.injected_token_overhead = Math.ceil(stdout.length / 4);
	metrics.ctx_sections_count = countSections(stdout);

	if (status !== 0) errors.push(`binary exited ${status}`);

	return {
		name: "E-token-overhead",
		passed: errors.length === 0,
		durationMs: Math.round(durationMs),
		metrics,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Session review mode
// ---------------------------------------------------------------------------

function extractLastUserMessage(jsonlPath: string): string | null {
	try {
		const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const obj = JSON.parse(lines[i]);
				// Claude Code JSONL format: { type: "user", message: { content: string | [{type,text}] } }
				if (obj?.type === "user") {
					const content = obj?.message?.content;
					if (typeof content === "string" && content.trim()) return content.slice(0, 120);
					if (Array.isArray(content)) {
						const text = content
							.filter((c: { type?: string }) => c?.type === "text")
							.map((c: { text?: string }) => c?.text ?? "")
							.join(" ")
							.trim();
						if (text) return text.slice(0, 120);
					}
				}
			} catch {
				// skip malformed line
			}
		}
	} catch {
		// file unreadable
	}
	return null;
}

function extractLastCodexMessage(historyPath: string): string | null {
	try {
		const lines = fs.readFileSync(historyPath, "utf-8").trim().split("\n").filter(Boolean);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const obj = JSON.parse(lines[i]);
				// Codex history.jsonl: { role: "user", content: string }
				if (obj?.role === "user" && typeof obj?.content === "string" && obj.content.trim()) {
					return obj.content.slice(0, 120);
				}
			} catch {
				// skip
			}
		}
	} catch {
		// file unreadable
	}
	return null;
}

function scoreSession(source: string, query: string, memoryDir: string): SessionReviewResult {
	const start = performance.now();
	const safeQuery = query.replace(/["\\]/g, " ").slice(0, 80);
	const { stdout, status } = runBinary(["context", "--query", safeQuery, "--no-search"], {
		AGENT_MEMORY_DIR: memoryDir,
	});
	const durationMs = performance.now() - start;

	const sectionsPresent = countSections(stdout);
	const outputChars = stdout.length;
	const queryWords = safeQuery
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length > 3);
	const hasRelevantContent = queryWords.length > 0 && queryWords.some((w) => stdout.toLowerCase().includes(w));
	const coherent = outputChars > 200 && sectionsPresent >= 2;

	return {
		source,
		query: safeQuery,
		status: status ?? -1,
		outputChars,
		sectionsPresent,
		latencyMs: Math.round(durationMs),
		hasRelevantContent,
		coherent,
	};
}

async function runReview(): Promise<{ results: SessionReviewResult[]; report: HarnessReport }> {
	const realMemoryDir = process.env.AGENT_MEMORY_DIR ?? path.join(os.homedir(), ".agent-memory");
	const results: SessionReviewResult[] = [];
	const startedAt = new Date().toISOString();

	// Claude Code sessions
	const claudeProjects = path.join(os.homedir(), ".claude", "projects");
	if (fs.existsSync(claudeProjects)) {
		const jsonlFiles: { path: string; mtime: number }[] = [];
		const walk = (dir: string) => {
			try {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) walk(full);
					else if (entry.name.endsWith(".jsonl")) {
						const mtime = fs.statSync(full).mtimeMs;
						jsonlFiles.push({ path: full, mtime });
					}
				}
			} catch {
				// skip unreadable dirs
			}
		};
		walk(claudeProjects);
		jsonlFiles.sort((a, b) => b.mtime - a.mtime);

		for (const { path: p } of jsonlFiles.slice(0, 3)) {
			const msg = extractLastUserMessage(p);
			if (msg) results.push(scoreSession("claude-code", msg, realMemoryDir));
		}
	}

	// Codex sessions
	const codexHistory = path.join(os.homedir(), ".codex", "history.jsonl");
	if (fs.existsSync(codexHistory)) {
		const msg = extractLastCodexMessage(codexHistory);
		if (msg) results.push(scoreSession("codex", msg, realMemoryDir));
	}

	// pi sessions (check pi-memory session store)
	const piMemoryDir = process.env.AGENT_MEMORY_PI_MEMORY_DIR;
	if (piMemoryDir && fs.existsSync(path.join(piMemoryDir, "index.ts"))) {
		// pi-memory doesn't have a flat session log — note as detected but not reviewed
		results.push({
			source: "pi",
			query: "(no session log format)",
			status: 0,
			outputChars: 0,
			sectionsPresent: 0,
			latencyMs: 0,
			hasRelevantContent: false,
			coherent: false,
			skipped: true,
		});
	}

	const finishedAt = new Date().toISOString();
	const reviewed = results.filter((r) => !r.skipped);
	const coherent = reviewed.filter((r) => r.coherent).length;

	const report: HarnessReport = {
		schemaVersion: "harness-v1",
		startedAt,
		finishedAt,
		cases: [],
		ctxLatP50Ms: null,
		ctxLatP95Ms: null,
		ctxOutputChars: null,
		injectedTokenOverhead: null,
		staleHitRate: null,
		sessionsReviewed: reviewed.length,
		sessionsCoherent: coherent,
		sessionResults: results,
	};

	return { results, report };
}

// ---------------------------------------------------------------------------
// Main harness runner (exported for test/harness.test.ts)
// ---------------------------------------------------------------------------

export async function runHarness(opts: { latencySamples?: number } = {}): Promise<HarnessReport> {
	const startedAt = new Date().toISOString();
	const n = opts.latencySamples ?? 20;

	const cases: HarnessCase[] = [caseA(), caseB(n), caseC(), caseD(), caseE()];

	const caseB_metrics = cases.find((c) => c.name === "B-multishot-latency")?.metrics ?? {};
	const caseA_metrics = cases.find((c) => c.name === "A-oneshot-coherence")?.metrics ?? {};
	const caseD_metrics = cases.find((c) => c.name === "D-stale-filtering")?.metrics ?? {};
	const caseE_metrics = cases.find((c) => c.name === "E-token-overhead")?.metrics ?? {};

	return {
		schemaVersion: "harness-v1",
		startedAt,
		finishedAt: new Date().toISOString(),
		cases,
		ctxLatP50Ms: (caseB_metrics.ctx_lat_p50_ms as number) ?? null,
		ctxLatP95Ms: (caseB_metrics.ctx_lat_p95_ms as number) ?? null,
		ctxOutputChars: (caseA_metrics.ctx_output_chars as number) ?? null,
		injectedTokenOverhead: (caseE_metrics.injected_token_overhead as number) ?? null,
		staleHitRate: (caseD_metrics.stale_hit_rate as number) ?? null,
		sessionsReviewed: 0,
		sessionsCoherent: 0,
	};
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);
	const isReview = args.includes("--review");
	const isJson = args.includes("--json");

	if (isReview) {
		const { report } = await runReview();
		if (isJson) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			const reviewed = report.sessionsReviewed;
			const coherent = report.sessionsCoherent;
			const sessionResults =
				(report as HarnessReport & { sessionResults?: SessionReviewResult[] }).sessionResults ?? [];
			console.log(`\nSession Review`);
			console.log(`──────────────`);
			for (const r of sessionResults) {
				if (r.skipped) {
					console.log(`  ${r.source}: skipped (no session log format)`);
				} else {
					const status = r.coherent ? "✓" : "✗";
					console.log(
						`  ${status} ${r.source}: "${r.query.slice(0, 60)}..." → ${r.outputChars} chars, ${r.sectionsPresent} sections, ${r.latencyMs}ms`,
					);
				}
			}
			console.log(`\nSummary: ${coherent}/${reviewed} sessions coherent`);
		}
	} else {
		const report = await runHarness();
		if (isJson) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			console.log("\nHarness Results");
			console.log("───────────────");
			for (const c of report.cases) {
				const status = c.passed ? "✓" : "✗";
				const metricsStr = Object.entries(c.metrics)
					.filter(([, v]) => v !== null && v !== "skipped")
					.map(([k, v]) => `${k}=${v}`)
					.join("  ");
				console.log(`  ${status} ${c.name}  ${metricsStr}`);
				if (!c.passed) {
					for (const e of c.errors) console.log(`      ERROR: ${e}`);
				}
			}
			console.log(`\nLatency p50=${report.ctxLatP50Ms}ms  p95=${report.ctxLatP95Ms}ms`);
			console.log(`Context chars=${report.ctxOutputChars}  tokens≈${report.injectedTokenOverhead}`);
			console.log(`Stale hit rate=${report.staleHitRate}`);
		}
	}
}
