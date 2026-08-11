import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_clearUpdateTimer,
	_resetBaseDir,
	_setBaseDir,
	_setQmdAvailable,
	buildMemoryContext,
	ensureDirs,
	memoryWrite,
	todayStr,
	yesterdayStr,
} from "../src/core.js";
import { loadFeedbackDataset } from "./dataset.js";
import type {
	EvalFixture,
	FeedbackDataset,
	FeedbackEvalReport,
	FeedbackProbe,
	FeedbackProbeResult,
	FixtureWrite,
	IssueVerdict,
	ProbeOracle,
	RepeatedText,
} from "./types.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_DATASET = new URL("./datasets/external-feedback-v1.json", import.meta.url);

function expandTokens(value: string): string {
	return value.replaceAll("{{today}}", todayStr()).replaceAll("{{yesterday}}", yesterdayStr());
}

function expandText(value?: RepeatedText): string {
	if (!value) return "";
	return (
		expandTokens(value.prefix ?? "") +
		expandTokens(value.content).repeat(value.repeat ?? 1) +
		expandTokens(value.suffix ?? "")
	);
}

function resolveFixture(dataset: FeedbackDataset, probe: FeedbackProbe): EvalFixture {
	const shared = probe.fixtureId ? dataset.fixtures[probe.fixtureId] : undefined;
	return {
		files: [...(shared?.files ?? []), ...(probe.fixture?.files ?? [])],
		externalFiles: [...(shared?.externalFiles ?? []), ...(probe.fixture?.externalFiles ?? [])],
		writes: [...(shared?.writes ?? []), ...(probe.fixture?.writes ?? [])],
		searchResults: probe.fixture?.searchResults ?? shared?.searchResults,
	};
}

function writeFixtureFiles(root: string, files: EvalFixture["files"]): void {
	for (const file of files ?? []) {
		const target = path.resolve(root, expandTokens(file.path));
		if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
			throw new Error(`fixture path escapes root: ${file.path}`);
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, expandText(file), "utf-8");
	}
}

function collectFiles(root: string): string {
	if (!fs.existsSync(root)) return "";
	const chunks: string[] = [];
	const visit = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else chunks.push(`${path.relative(root, fullPath)}\n${fs.readFileSync(fullPath, "utf-8")}`);
		}
	};
	visit(root);
	return chunks.join("\n\n");
}

function scoreOutput(output: string, oracle: ProbeOracle): { passed: boolean; assertions: string[] } {
	const assertions: string[] = [];
	for (const marker of oracle.requiredMarkers ?? []) {
		if (!output.includes(marker)) assertions.push(`missing required marker: ${marker}`);
	}
	for (const marker of oracle.forbiddenMarkers ?? []) {
		if (output.includes(marker)) assertions.push(`included forbidden marker: ${marker}`);
	}
	if (oracle.maxChars !== undefined && output.length > oracle.maxChars) {
		assertions.push(`output length ${output.length} exceeded ${oracle.maxChars}`);
	}
	return { passed: assertions.length === 0, assertions };
}

async function runPromptRoutingProbe(probe: FeedbackProbe): Promise<FeedbackProbeResult> {
	const started = performance.now();
	const marker = "EVAL_PROMPT_ROUTING_RESULT";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-prompt-routing-eval-"));
	const shellMarker = path.join(root, "PROMPT_WAS_EXECUTED");
	const query = 'route $(touch PROMPT_WAS_EXECUTED) and `touch PROMPT_WAS_EXECUTED` with "quotes"';
	const memoryRoot = path.join(root, "memory");
	const binRoot = path.join(root, "bin");
	const captureFile = path.join(root, "qmd-args.json");
	const qmdShim = path.join(binRoot, "qmd");
	fs.mkdirSync(binRoot, { recursive: true });
	fs.mkdirSync(path.join(memoryRoot, "daily"), { recursive: true });
	fs.writeFileSync(path.join(memoryRoot, "daily", "eval.md"), marker, "utf-8");
	fs.writeFileSync(
		qmdShim,
		`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "status") { process.stdout.write("ok\\n"); process.exit(0); }\nif (args[0] === "collection" && args[1] === "list") { process.stdout.write(JSON.stringify([{ name: "agent-memory" }])); process.exit(0); }\nif (args[0] === "search") { fs.writeFileSync(process.env.QMD_CAPTURE_FILE, JSON.stringify(args)); process.stdout.write(JSON.stringify([{ path: "qmd://agent-memory/daily/eval.md", content: "${marker}" }])); process.exit(0); }\nprocess.stderr.write("unexpected qmd arguments: " + JSON.stringify(args));\nprocess.exit(1);\n`,
		"utf-8",
	);
	fs.chmodSync(qmdShim, 0o755);

	try {
		const result = spawnSync(
			process.execPath,
			[path.join(REPO_ROOT, "src/cli.ts"), "context", "--query", query, "--dir", memoryRoot],
			{
				encoding: "utf-8",
				cwd: root,
				env: {
					...process.env,
					AGENT_MEMORY_QMD_UPDATE: "off",
					PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
					QMD_CAPTURE_FILE: captureFile,
				},
				timeout: 2_000,
			},
		);
		const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf-8");
		const skills = ["agent", "claude-code", "codex", "cursor"].map((name) =>
			fs.readFileSync(path.join(REPO_ROOT, `skills/${name}/SKILL.md`), "utf-8"),
		);
		const assertions: string[] = [];
		if (result.error) assertions.push(`CLI context probe failed to execute: ${result.error.message}`);
		else if (result.status !== 0) assertions.push(`CLI context exited ${result.status}: ${result.stderr.trim()}`);
		if (!result.stdout.includes(marker)) assertions.push("CLI context did not return the query-specific qmd result");
		if (!fs.existsSync(captureFile)) {
			assertions.push("CLI context did not invoke qmd search");
		} else {
			const captured: unknown = JSON.parse(fs.readFileSync(captureFile, "utf-8"));
			if (!Array.isArray(captured) || !captured.includes(query)) {
				assertions.push("CLI context did not pass the query argument to qmd search");
			}
		}
		if (fs.existsSync(shellMarker)) assertions.push("CLI prompt transport executed shell syntax");
		if (/before every (?:agent |user )?turn/i.test(readme)) {
			assertions.push("README still promises host-enforced per-turn retrieval");
		}
		if (skills.some((skill) => skill.includes("query-stdin") || /before every user turn/i.test(skill))) {
			assertions.push("installed skills still depend on the removed per-turn stdin contract");
		}
		return {
			probeId: probe.id,
			issueId: probe.issueId,
			title: probe.title,
			status: assertions.length === 0 ? "passed" : "failed",
			evaluator: probe.evaluator,
			assertions,
			durationMs: performance.now() - started,
		};
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

type MemoryWriteParamsWithProvenance = Parameters<typeof memoryWrite>[0] & { sourceUri?: string };

export function buildFixtureWriteParams(write: FixtureWrite): MemoryWriteParamsWithProvenance {
	return {
		target: write.target,
		content: expandTokens(write.content),
		mode: write.mode,
		sessionId: write.sessionId,
		topic: write.topic,
		date: write.date,
		sourceUri: write.sourceUri,
	};
}

async function runIsolatedProbe(dataset: FeedbackDataset, probe: FeedbackProbe): Promise<FeedbackProbeResult> {
	const started = performance.now();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-feedback-eval-"));
	const memoryRoot = path.join(root, "memory");
	const externalRoot = path.join(root, "external");
	const fixture = resolveFixture(dataset, probe);
	const previousUpdateMode = process.env.AGENT_MEMORY_QMD_UPDATE;
	process.env.AGENT_MEMORY_QMD_UPDATE = "off";
	_setBaseDir(memoryRoot);
	_setQmdAvailable(false);
	ensureDirs();

	try {
		writeFixtureFiles(memoryRoot, fixture.files);
		writeFixtureFiles(externalRoot, fixture.externalFiles);
		for (const write of fixture.writes ?? []) {
			await memoryWrite(buildFixtureWriteParams(write));
		}

		let output = "";
		if (probe.evaluator === "context" || probe.evaluator === "cross-agent") {
			output = buildMemoryContext(expandText(fixture.searchResults));
		} else if (probe.evaluator === "write") {
			output = collectFiles(memoryRoot);
		} else if (probe.evaluator === "docs-boundary") {
			output = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf-8");
		}

		const scored = scoreOutput(output, probe.oracle);
		return {
			probeId: probe.id,
			issueId: probe.issueId,
			title: probe.title,
			status: scored.passed ? "passed" : "failed",
			evaluator: probe.evaluator,
			assertions: scored.assertions,
			observedChars: output.length,
			durationMs: performance.now() - started,
		};
	} finally {
		_clearUpdateTimer();
		_resetBaseDir();
		_setQmdAvailable(false);
		if (previousUpdateMode === undefined) delete process.env.AGENT_MEMORY_QMD_UPDATE;
		else process.env.AGENT_MEMORY_QMD_UPDATE = previousUpdateMode;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function parseQmdResults(stdout: string): Array<Record<string, unknown>> {
	// qmd may emit terminal progress before its JSON payload.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
	const cleaned = stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
	const lines = cleaned.split(/\r?\n/);
	const start = lines.findIndex((line) => {
		const trimmed = line.trimStart();
		return trimmed.startsWith("[") || trimmed.startsWith("{");
	});
	if (start === -1) return [];
	const parsed: unknown = JSON.parse(lines.slice(start).join("\n"));
	if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
	if (parsed && typeof parsed === "object") {
		const record = parsed as Record<string, unknown>;
		const results = record.results ?? record.hits;
		if (Array.isArray(results)) return results as Array<Record<string, unknown>>;
	}
	return [];
}

function runQmd(args: string[], env: NodeJS.ProcessEnv, timeout = 180_000): string {
	const result = spawnSync("qmd", args, { encoding: "utf-8", env, timeout });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `qmd exited ${result.status}`);
	return result.stdout;
}

async function runLiveQmdProbes(dataset: FeedbackDataset, probes: FeedbackProbe[]): Promise<FeedbackProbeResult[]> {
	if (probes.length === 0) return [];
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-qmd-eval-"));
	const dataRoot = path.join(root, "documents");
	const configRoot = path.join(root, "config");
	const cacheRoot = path.join(root, "cache");
	fs.mkdirSync(dataRoot, { recursive: true });
	fs.mkdirSync(configRoot, { recursive: true });
	fs.mkdirSync(cacheRoot, { recursive: true });
	const env = {
		...process.env,
		QMD_CONFIG_DIR: configRoot,
		XDG_CACHE_HOME: cacheRoot,
		NO_COLOR: "1",
		FORCE_COLOR: "0",
	};
	const indexName = "external-feedback-v1";
	const collectionName = "feedback-eval";

	try {
		const fixtureIds = new Set(probes.map((probe) => probe.fixtureId).filter((id): id is string => Boolean(id)));
		for (const fixtureId of fixtureIds) writeFixtureFiles(dataRoot, dataset.fixtures[fixtureId]?.files);
		runQmd(["--index", indexName, "collection", "add", dataRoot, "--name", collectionName], env);
		if (probes.some((probe) => probe.mode !== "keyword")) runQmd(["--index", indexName, "embed"], env, 600_000);

		return probes.map((probe) => {
			const started = performance.now();
			try {
				const command = probe.mode === "keyword" ? "search" : probe.mode === "semantic" ? "vsearch" : "query";
				const stdout = runQmd(
					["--index", indexName, command, "--json", "-c", collectionName, "-n", "5", probe.query ?? ""],
					env,
					probe.mode === "deep" ? 600_000 : 180_000,
				);
				const rows = parseQmdResults(stdout);
				const allReturnedSources = rows
					.map((row) => String(row.path ?? row.file ?? ""))
					.filter(Boolean)
					.map((source) => path.basename(source, path.extname(source)));
				const returnedSources = allReturnedSources.slice(0, probe.oracle.topK ?? 5);
				const scored = scoreOutput(returnedSources.join("\n"), probe.oracle);
				return {
					probeId: probe.id,
					issueId: probe.issueId,
					title: probe.title,
					status: scored.passed ? "passed" : "failed",
					evaluator: probe.evaluator,
					assertions: scored.assertions,
					returnedSources,
					durationMs: performance.now() - started,
				} satisfies FeedbackProbeResult;
			} catch (error) {
				return {
					probeId: probe.id,
					issueId: probe.issueId,
					title: probe.title,
					status: "failed",
					evaluator: probe.evaluator,
					assertions: [error instanceof Error ? error.message : String(error)],
					durationMs: performance.now() - started,
				} satisfies FeedbackProbeResult;
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`live qmd setup failed: ${message}`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function deferredResult(probe: FeedbackProbe): FeedbackProbeResult {
	return {
		probeId: probe.id,
		issueId: probe.issueId,
		title: probe.title,
		status: "deferred",
		evaluator: probe.evaluator,
		assertions: ["requires --live-qmd"],
		durationMs: 0,
	};
}

function buildIssueVerdicts(dataset: FeedbackDataset, results: FeedbackProbeResult[]): IssueVerdict[] {
	return dataset.issues.map((issue) => {
		const issueResults = results.filter((result) => result.issueId === issue.id);
		const passed = issueResults.filter((result) => result.status === "passed").length;
		const failed = issueResults.filter((result) => result.status === "failed").length;
		const deferred = issueResults.filter((result) => result.status === "deferred").length;
		let verdict: IssueVerdict["verdict"];
		if (passed > 0 && failed > 0) verdict = "mixed";
		else if (failed > 0) verdict = "confirmed";
		else if (passed > 0) verdict = "not-reproduced";
		else verdict = "deferred";
		return {
			issueId: issue.id,
			title: issue.title,
			classification: issue.classification,
			verdict,
			passed,
			failed,
			deferred,
		};
	});
}

export async function runFeedbackEvaluation(
	options: { dataset?: string | URL; liveQmd?: boolean } = {},
): Promise<FeedbackEvalReport> {
	const startedAt = new Date().toISOString();
	const dataset = await loadFeedbackDataset(options.dataset ?? DEFAULT_DATASET);
	const results: FeedbackProbeResult[] = [];
	const liveProbes: FeedbackProbe[] = [];

	for (const probe of dataset.probes) {
		if (probe.evaluator === "live-qmd") {
			liveProbes.push(probe);
			continue;
		}
		if (probe.evaluator === "prompt-routing") results.push(await runPromptRoutingProbe(probe));
		else results.push(await runIsolatedProbe(dataset, probe));
	}

	if (options.liveQmd) results.push(...(await runLiveQmdProbes(dataset, liveProbes)));
	else results.push(...liveProbes.map(deferredResult));

	return {
		schemaVersion: "1",
		datasetVersion: dataset.version,
		startedAt,
		finishedAt: new Date().toISOString(),
		liveQmd: options.liveQmd ?? false,
		probes: results,
		issues: buildIssueVerdicts(dataset, results),
	};
}

function printReport(report: FeedbackEvalReport): void {
	console.log(`External feedback evaluation: ${report.datasetVersion}`);
	for (const issue of report.issues) {
		console.log(
			`${issue.verdict.padEnd(14)} ${issue.issueId} (${issue.failed} failed, ${issue.passed} passed, ${issue.deferred} deferred)`,
		);
	}
	console.log("\nProbe details:");
	for (const probe of report.probes) {
		console.log(`${probe.status.padEnd(8)} ${probe.probeId}`);
		for (const assertion of probe.assertions) console.log(`  - ${assertion}`);
		if (probe.returnedSources) console.log(`  - sources: ${probe.returnedSources.join(", ") || "none"}`);
	}
}

if (import.meta.main) {
	const args = new Set(process.argv.slice(2));
	const report = await runFeedbackEvaluation({ liveQmd: args.has("--live-qmd") });
	if (args.has("--json")) console.log(JSON.stringify(report, null, 2));
	else printReport(report);
	if (args.has("--strict") && report.probes.some((probe) => probe.status === "failed")) process.exitCode = 1;
}
