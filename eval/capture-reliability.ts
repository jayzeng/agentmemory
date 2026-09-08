import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkCaptureTranscript, isExplicitMemoryRequest } from "../src/capture-check.js";
import { coreCaptureContextForQuery } from "../src/plugin-runtime.js";

export type CaptureHarness = "claude" | "codex" | "cursor" | "qoder" | "pi";
export type CaptureEnforcement = "mechanized" | "partially-mechanized" | "instruction-guided" | "delegated";

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
		mechanizedExplicitRequestCoverage: number;
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

const CODEX_SESSION = "11111111-2222-3333-4444-555555555555";

function codexMeta(): unknown {
	return {
		timestamp: "2026-09-08T22:00:00Z",
		type: "session_meta",
		payload: { session_id: CODEX_SESSION, id: CODEX_SESSION, cwd: "/repo", source: "cli" },
	};
}

function codexCall(type: "function_call" | "custom_tool_call", name: string, callId: string, args: unknown): unknown {
	return {
		timestamp: "2026-09-08T22:00:01Z",
		type: "response_item",
		payload: { type, name, call_id: callId, arguments: typeof args === "string" ? args : JSON.stringify(args) },
	};
}

function codexOutput(
	type: "function_call_output" | "custom_tool_call_output",
	callId: string,
	value: unknown,
): unknown {
	return {
		timestamp: "2026-09-08T22:00:02Z",
		type: "response_item",
		payload: { type, call_id: callId, output: value },
	};
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
			notes: ["Claude has a transcript-aware Stop capture check for explicit requests and completed work."],
		};
	} finally {
		for (const transcript of paths) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
	}
}

function evaluateCodexMechanism(): Pick<
	CaptureHarnessResult,
	"mechanizedExplicitRequest" | "mechanizedCompletedWork" | "mechanizedWriteClearsSignal" | "notes"
> {
	const paths: string[] = [];
	try {
		const explicit = coreCaptureContextForQuery("Remember this: staging uses PostgreSQL.");
		const negative = coreCaptureContextForQuery("Do not remember this: staging uses PostgreSQL.");
		const completed = writeTranscript([
			codexMeta(),
			codexCall("custom_tool_call", "apply_patch", "patch-1", "*** Begin Patch\n*** End Patch"),
			codexOutput("custom_tool_call_output", "patch-1", { content: "Done!", success: true }),
		]);
		paths.push(completed);
		const cleared = writeTranscript([
			codexMeta(),
			codexCall("custom_tool_call", "apply_patch", "patch-1", "*** Begin Patch\n*** End Patch"),
			codexOutput("custom_tool_call_output", "patch-1", { content: "Done!", success: true }),
			codexCall("function_call", "exec_command", "write-1", {
				cmd: 'agent-memory write --content "staging uses PostgreSQL"',
			}),
			codexOutput("function_call_output", "write-1", {
				content:
					"Chunk ID: abc\nProcess exited with code 0\nFinal output:\nAppended to daily log: /memory/daily/2026-09-08.md",
				success: true,
			}),
		]);
		paths.push(cleared);
		const completedCheck = checkCaptureTranscript(completed, CODEX_SESSION);
		const clearedCheck = checkCaptureTranscript(cleared, CODEX_SESSION);
		return {
			mechanizedExplicitRequest:
				explicit.some(
					(section) =>
						section.id === "core.capture.explicit-memory-request" &&
						section.content.includes("Save the durable fact in this turn"),
				) && negative.length === 0,
			mechanizedCompletedWork: Boolean(completedCheck?.pendingSignal),
			mechanizedWriteClearsSignal: clearedCheck !== null && clearedCheck.pendingSignal === undefined,
			notes: [
				"Codex UserPromptSubmit deterministically injects a Core capture check for explicit memory requests.",
				"Codex Stop uses the persisted rollout parser to detect completed apply_patch work and clears the signal after a verified AgentMemory write.",
			],
		};
	} finally {
		for (const transcript of paths) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
	}
}

export function runCaptureReliabilityEvaluation(): CaptureReliabilityReport {
	const claudeMechanism = evaluateClaudeMechanism();
	const codexMechanism = evaluateCodexMechanism();
	const localResults = LOCAL_SKILLS.map<CaptureHarnessResult>(({ harness, path: skillPath }) => {
		if (harness === "claude") {
			return {
				harness,
				enforcement: "mechanized",
				measured: true,
				instructionContract: skillHasCaptureContract(skillPath),
				mechanizedExplicitRequest: claudeMechanism.mechanizedExplicitRequest,
				mechanizedCompletedWork: claudeMechanism.mechanizedCompletedWork,
				mechanizedWriteClearsSignal: claudeMechanism.mechanizedWriteClearsSignal,
				notes: claudeMechanism.notes,
			};
		}
		if (harness === "codex") {
			return {
				harness,
				enforcement: "mechanized",
				measured: true,
				instructionContract: skillHasCaptureContract(skillPath),
				mechanizedExplicitRequest: codexMechanism.mechanizedExplicitRequest,
				mechanizedCompletedWork: codexMechanism.mechanizedCompletedWork,
				mechanizedWriteClearsSignal: codexMechanism.mechanizedWriteClearsSignal,
				notes: codexMechanism.notes,
			};
		}
		return {
			harness,
			enforcement: "instruction-guided",
			measured: true,
			instructionContract: skillHasCaptureContract(skillPath),
			mechanizedExplicitRequest: null,
			mechanizedCompletedWork: null,
			mechanizedWriteClearsSignal: null,
			notes: [
				"Capture relies on the installed skill/checkpoint discipline; model compliance is not deterministically measured here.",
			],
		};
	});
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
	const mechanizedExplicitRequestCoverage =
		measured.filter((result) => result.mechanizedExplicitRequest === true).length / measured.length;
	const mechanizedImmediateCoverage =
		measured.filter(
			(result) =>
				result.mechanizedExplicitRequest === true &&
				result.mechanizedCompletedWork === true &&
				result.mechanizedWriteClearsSignal === true,
		).length / measured.length;
	const passed =
		instructionCoverage === 1 &&
		mechanizedExplicitRequestCoverage === 0.5 &&
		mechanizedImmediateCoverage === 0.5 &&
		claudeMechanism.mechanizedWriteClearsSignal === true &&
		codexMechanism.mechanizedExplicitRequest === true &&
		codexMechanism.mechanizedCompletedWork === true &&
		codexMechanism.mechanizedWriteClearsSignal === true &&
		isExplicitMemoryRequest("Remember this: staging uses PostgreSQL.") &&
		!isExplicitMemoryRequest("Do not remember this: staging uses PostgreSQL.");
	return {
		schemaVersion: "capture-reliability-v1",
		harnesses,
		metrics: {
			measuredHarnesses: measured.length,
			instructionCoverage,
			mechanizedExplicitRequestCoverage,
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
