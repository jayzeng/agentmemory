import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkCaptureTranscript, isExplicitMemoryRequest } from "../src/capture-check.js";

export type CaptureHarness = "claude" | "codex" | "cursor" | "qoder" | "pi";
export type CaptureEnforcement = "mechanized" | "instruction-guided" | "delegated";

export interface CaptureHarnessResult {
	harness: CaptureHarness;
	enforcement: CaptureEnforcement;
	measured: boolean;
	instructionContract: boolean | null;
	mechanizedExplicitRequest: boolean | null;
	mechanizedCompletedWork: boolean | null;
	mechanizedWriteClearsSignal: boolean | null;
	notes: string[];
}

export interface CaptureReliabilityReport {
	schemaVersion: "capture-reliability-v1";
	harnesses: CaptureHarnessResult[];
	metrics: {
		measuredHarnesses: number;
		instructionCoverage: number;
		mechanizedImmediateCoverage: number;
		delegatedHarnesses: number;
	};
	passed: boolean;
}

const ROOT = path.resolve(import.meta.dir, "..");
const REQUIRED_GUIDANCE = [
	"When the user explicitly asks you to remember something, save it in that turn.",
	"verify the tool succeeded",
	"Avoid duplicate notes",
];

const LOCAL_SKILLS: Array<{ harness: Exclude<CaptureHarness, "pi">; path: string }> = [
	{ harness: "claude", path: "skills/claude-code/SKILL.md" },
	{ harness: "codex", path: "skills/codex/SKILL.md" },
	{ harness: "cursor", path: "skills/cursor/SKILL.md" },
	{ harness: "qoder", path: "skills/qoder/SKILL.md" },
];

function skillHasCaptureContract(relativePath: string): boolean {
	try {
		const content = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
		return REQUIRED_GUIDANCE.every((marker) => content.includes(marker));
	} catch {
		return false;
	}
}

function writeTranscript(records: unknown[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-capture-eval-"));
	const transcript = path.join(dir, "session.jsonl");
	fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	return transcript;
}

function userMessage(text: string): unknown {
	return { type: "user", uuid: "request", message: { role: "user", content: text } };
}

function toolExchange(name: string, id: string, input: unknown, content: string): unknown[] {
	return [
		{ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } },
		{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } },
	];
}

function evaluateClaudeMechanism(): Pick<
	CaptureHarnessResult,
	"mechanizedExplicitRequest" | "mechanizedCompletedWork" | "mechanizedWriteClearsSignal" | "notes"
> {
	const paths: string[] = [];
	try {
		const explicit = writeTranscript([userMessage("Remember this: staging uses PostgreSQL.")]);
		paths.push(explicit);
		const completed = writeTranscript(toolExchange("Edit", "edit-1", { file_path: "/repo/auth.ts" }, "Updated"));
		paths.push(completed);
		const cleared = writeTranscript([
			userMessage("Remember this: staging uses PostgreSQL."),
			...toolExchange(
				"Bash",
				"write-1",
				{ command: 'agent-memory write --content "staging uses PostgreSQL"' },
				"Appended to daily log: /memory/daily/2026-09-08.md",
			),
		]);
		paths.push(cleared);
		const explicitCheck = checkCaptureTranscript(explicit, "capture-eval");
		const completedCheck = checkCaptureTranscript(completed, "capture-eval");
		const clearedCheck = checkCaptureTranscript(cleared, "capture-eval");
		return {
			mechanizedExplicitRequest: Boolean(explicitCheck?.pendingSignal),
			mechanizedCompletedWork: Boolean(completedCheck?.pendingSignal),
			mechanizedWriteClearsSignal: clearedCheck !== null && clearedCheck.pendingSignal === undefined,
			notes: ["Claude is the only local harness with a transcript-aware Stop capture check."],
		};
	} finally {
		for (const transcript of paths) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
	}
}

export function runCaptureReliabilityEvaluation(): CaptureReliabilityReport {
	const claudeMechanism = evaluateClaudeMechanism();
	const localResults = LOCAL_SKILLS.map<CaptureHarnessResult>(({ harness, path: skillPath }) => ({
		harness,
		enforcement: harness === "claude" ? "mechanized" : "instruction-guided",
		measured: true,
		instructionContract: skillHasCaptureContract(skillPath),
		mechanizedExplicitRequest: harness === "claude" ? claudeMechanism.mechanizedExplicitRequest : null,
		mechanizedCompletedWork: harness === "claude" ? claudeMechanism.mechanizedCompletedWork : null,
		mechanizedWriteClearsSignal: harness === "claude" ? claudeMechanism.mechanizedWriteClearsSignal : null,
		notes:
			harness === "claude"
				? claudeMechanism.notes
				: [
						"Capture relies on the installed skill/checkpoint discipline; model compliance is not deterministically measured here.",
					],
	}));
	const pi: CaptureHarnessResult = {
		harness: "pi",
		enforcement: "delegated",
		measured: false,
		instructionContract: null,
		mechanizedExplicitRequest: null,
		mechanizedCompletedWork: null,
		mechanizedWriteClearsSignal: null,
		notes: [
			"Pi capture is delegated to the separately versioned pi-memory extension and is intentionally excluded from this repo's denominator.",
		],
	};
	const harnesses = [...localResults, pi];
	const measured = harnesses.filter((result) => result.measured);
	const instructionCoverage = measured.filter((result) => result.instructionContract).length / measured.length;
	const mechanizedImmediateCoverage =
		measured.filter((result) => result.mechanizedExplicitRequest === true && result.mechanizedCompletedWork === true)
			.length / measured.length;
	const passed =
		instructionCoverage === 1 &&
		claudeMechanism.mechanizedExplicitRequest === true &&
		claudeMechanism.mechanizedCompletedWork === true &&
		claudeMechanism.mechanizedWriteClearsSignal === true &&
		isExplicitMemoryRequest("Remember this: staging uses PostgreSQL.") &&
		!isExplicitMemoryRequest("Do not remember this: staging uses PostgreSQL.");
	return {
		schemaVersion: "capture-reliability-v1",
		harnesses,
		metrics: {
			measuredHarnesses: measured.length,
			instructionCoverage,
			mechanizedImmediateCoverage,
			delegatedHarnesses: harnesses.filter((result) => result.enforcement === "delegated").length,
		},
		passed,
	};
}

if (import.meta.main) {
	const report = runCaptureReliabilityEvaluation();
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (!report.passed) process.exitCode = 1;
}
