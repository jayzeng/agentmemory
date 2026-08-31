#!/usr/bin/env bun
/**
 * LongMemEval-S retrieval benchmark for our qmd-backed recall path.
 *
 * Public dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval
 * (500 Q; 6 types: single-session-user/assistant/preference, multi-session,
 * temporal-reasoning, knowledge-update)
 *
 * Downloads once, then runs stratified samples through the same parallel
 * qmd-search + qmd-vsearch fusion that `searchRelevantMemories` uses in
 * production. Per-question haystack is dumped into a fresh qmd index
 * (`--index lme-<pid>-<Q>`) so the user's real ~/.cache/qmd/index.sqlite
 * is not touched.
 *
 * Env / flags:
 *   LONGMEMEVAL_PATH  path to longmemeval_s.json (default ~/datasets/…)
 *   --stratify N      pick N questions per type (default 10, 0 = full 500)
 *   --k K             top-k for R@K (default 5)
 *   --out DIR         write scores.ndjson + summary.json (default eval/reports/longmemeval)
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type QmdSearchResult, runQmdSearch } from "../src/core.js";

interface RawQ {
	question_id: string;
	question_type: string;
	question: string;
	answer_session_ids: string[];
	haystack_session_ids: string[];
	haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

interface ScoreRow {
	questionId: string;
	questionType: string;
	k: number;
	hit: boolean;
	recallAtK: number;
	topGoldRank: number | null;
	latencyMs: number;
}

const QMD_BIN = process.env.QMD_BIN ?? "qmd";

function runQmdCli(args: string[], timeoutMs = 300_000): Promise<void> {
	return new Promise((res, rej) => {
		const c = spawn(QMD_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		const timer = setTimeout(() => {
			c.kill("SIGKILL");
			rej(new Error(`qmd ${args.slice(0, 2).join(" ")} timeout`));
		}, timeoutMs);
		c.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		c.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) res();
			else rej(new Error(`qmd ${args.slice(0, 2).join(" ")} exit ${code}: ${stderr}`));
		});
	});
}

function sanitize(id: string): string {
	return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function resolveSessionId(r: QmdSearchResult, fileToSession: Map<string, string>): string | undefined {
	const title = typeof r.title === "string" ? r.title : "";
	if (title) {
		const byTitle = fileToSession.get(title);
		if (byTitle) return byTitle;
	}
	const p = r.path ?? r.file;
	if (typeof p !== "string") return undefined;
	if (fileToSession.has(p)) return fileToSession.get(p);
	const base = p.slice(p.lastIndexOf("/") + 1);
	const stem = base.endsWith(".md") ? base.slice(0, -3) : base;
	return fileToSession.get(stem) ?? fileToSession.get(stem.replace(/-/g, "_"));
}

function stratify(raws: RawQ[], perType: number): RawQ[] {
	if (perType <= 0) return raws;
	const buckets: Record<string, RawQ[]> = {};
	for (const r of raws) {
		const bucket = buckets[r.question_type] ?? [];
		bucket.push(r);
		buckets[r.question_type] = bucket;
	}
	const out: RawQ[] = [];
	for (const type of Object.keys(buckets).sort()) out.push(...buckets[type].slice(0, perType));
	return out;
}

function fmt(r: number): string {
	return `${(r * 100).toFixed(1)}%`;
}

async function scoreOne(q: RawQ, k: number, pid: number, qIdx: number): Promise<ScoreRow> {
	const t0 = performance.now();
	const dir = mkdtempSync(join(tmpdir(), `lme-${pid}-`));
	const indexName = `lme-${pid}-${qIdx}`;
	const collection = `lme-${pid}-${qIdx}`;
	const fileToSession = new Map<string, string>();
	try {
		for (let i = 0; i < q.haystack_session_ids.length; i++) {
			const sid = q.haystack_session_ids[i];
			const content = q.haystack_sessions[i].map((t) => `[${t.role}] ${t.content}`).join("\n\n");
			if (!content.trim()) continue;
			const safe = sanitize(sid);
			writeFileSync(join(dir, `${safe}.md`), content, "utf8");
			fileToSession.set(safe, sid);
			fileToSession.set(join(dir, `${safe}.md`), sid);
		}
		await runQmdCli(["--index", indexName, "collection", "add", dir, "--name", collection, "--pattern", "**/*.md"]);
		await runQmdCli(["--index", indexName, "embed"]);
		// Single typed lex+vec call — same shape as production searchRelevantMemories.
		const settled = await runQmdSearch("deep", q.question, Math.max(k * 4, 20), { index: indexName, collection });
		const ranked: string[] = [];
		const seen = new Set<string>();
		for (const r of settled.results) {
			const sid = resolveSessionId(r, fileToSession);
			if (!sid || seen.has(sid)) continue;
			seen.add(sid);
			ranked.push(sid);
			if (ranked.length >= k) break;
		}
		const gold = new Set(q.answer_session_ids);
		let hits = 0;
		let topGoldRank: number | null = null;
		for (let i = 0; i < ranked.length; i++) {
			if (gold.has(ranked[i])) {
				hits++;
				if (topGoldRank === null) topGoldRank = i + 1;
			}
		}
		const recall = gold.size > 0 ? hits / gold.size : 0;
		return {
			questionId: q.question_id,
			questionType: q.question_type,
			k,
			hit: topGoldRank !== null,
			recallAtK: Math.min(1, recall),
			topGoldRank,
			latencyMs: performance.now() - t0,
		};
	} finally {
		try {
			await runQmdCli(["--index", indexName, "collection", "remove", collection], 30_000);
		} catch {}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			data: {
				type: "string",
				default: process.env.LONGMEMEVAL_PATH ?? `${process.env.HOME}/datasets/longmemeval/longmemeval_s.json`,
			},
			stratify: { type: "string", default: "10" },
			k: { type: "string", default: "5" },
			out: { type: "string", default: "eval/reports/longmemeval" },
		},
	});
	const dataPath = resolve(values.data as string);
	if (!existsSync(dataPath)) {
		console.error(`LongMemEval-S dataset not found at ${dataPath}`);
		console.error("Download:");
		console.error(
			`  mkdir -p ~/datasets/longmemeval && curl -Lo ~/datasets/longmemeval/longmemeval_s.json https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s`,
		);
		process.exit(2);
	}
	const k = Number(values.k);
	const perType = Number(values.stratify);
	const outDir = resolve(values.out as string);
	mkdirSync(outDir, { recursive: true });
	const ndjsonPath = join(outDir, "scores.ndjson");
	writeFileSync(ndjsonPath, "");

	const raws = JSON.parse(readFileSync(dataPath, "utf8")) as RawQ[];
	const questions = stratify(raws, perType);
	console.log(`LongMemEval-S: ${questions.length} questions (perType=${perType}), k=${k}`);
	console.log(`writing scores → ${ndjsonPath}`);

	const rows: ScoreRow[] = [];
	const pid = process.pid;
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const row = await scoreOne(q, k, pid, i);
		rows.push(row);
		appendFileSync(ndjsonPath, `${JSON.stringify(row)}\n`);
		const mark = row.hit ? "+" : "-";
		console.log(
			`  ${mark} ${q.question_id} [${q.question_type.padEnd(24)}] R@${k}=${row.recallAtK.toFixed(2)} (${Math.round(row.latencyMs)}ms)`,
		);
	}

	const byType: Record<string, { hit: number; recallSum: number; n: number; latencySum: number }> = {};
	let totalHit = 0;
	let totalRecall = 0;
	let totalLatency = 0;
	for (const row of rows) {
		const b = byType[row.questionType] ?? { hit: 0, recallSum: 0, n: 0, latencySum: 0 };
		byType[row.questionType] = b;
		b.n++;
		if (row.hit) b.hit++;
		b.recallSum += row.recallAtK;
		b.latencySum += row.latencyMs;
		if (row.hit) totalHit++;
		totalRecall += row.recallAtK;
		totalLatency += row.latencyMs;
	}
	const summary = {
		n: rows.length,
		k,
		hit: totalHit,
		recallAtK: totalRecall / (rows.length || 1),
		hitRate: totalHit / (rows.length || 1),
		latencyMeanMs: totalLatency / (rows.length || 1),
		byType: Object.fromEntries(
			Object.entries(byType).map(([type, b]) => [
				type,
				{
					n: b.n,
					hit: b.hit,
					recallAtK: b.recallSum / b.n,
					hitRate: b.hit / b.n,
					latencyMeanMs: b.latencySum / b.n,
				},
			]),
		),
	};
	writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

	console.log("\n=== Summary ===");
	console.log(
		`overall  R@${k}=${fmt(summary.recallAtK)} hit=${summary.hit}/${summary.n} p_mean=${Math.round(summary.latencyMeanMs)}ms`,
	);
	console.log("by type:");
	for (const [type, stats] of Object.entries(summary.byType)) {
		console.log(
			`  ${type.padEnd(28)} R@${k}=${fmt(stats.recallAtK)} hit=${stats.hit}/${stats.n} mean=${Math.round(stats.latencyMeanMs)}ms`,
		);
	}
	console.log(`\nwrote ${ndjsonPath}`);
	console.log(`wrote ${join(outDir, "summary.json")}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
