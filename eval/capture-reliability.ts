import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkCaptureTranscript, isExplicitMemoryRequest } from "../src/capture-check.js";
import { reduceCursorCaptureEvent } from "../src/cursor-capture.js";
import { coreCaptureContextForQuery } from "../src/plugin-runtime.js";
import {
	CODEX_ROLLOUT_SESSION as CODEX_SESSION,
	codexCall,
	codexMeta,
	codexOutput,
} from "../test/fixtures/codex-rollout.js";

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

const QODER_SESSION = "qoder-capture-eval";

function qoderMeta(): unknown {
	return { type: "session_meta", sessionId: QODER_SESSION, uuid: "meta", data: { meta_type: "session_info" } };
}

function qoderUser(content: unknown, uuid: string): unknown {
	return { type: "user", sessionId: QODER_SESSION, uuid, message: { role: "user", content } };
}

function qoderTool(name: string, id: string, input: unknown, content: string, isError = false): unknown[] {
	return [
		{
			type: "assistant",
			sessionId: QODER_SESSION,
			uuid: `${id}-call`,
			message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
		},
		qoderUser([{ type: "tool_result", tool_use_id: id, content, is_error: isError }], `${id}-result`),
	];
}

function evaluateQoderMechanism(): Pick<
	CaptureHarnessResult,
	"mechanizedExplicitRequest" | "mechanizedCompletedWork" | "mechanizedWriteClearsSignal" | "notes"
> {
	const paths: string[] = [];
	try {
		const explicit = writeTranscript([qoderMeta(), qoderUser("Remember this: staging uses PostgreSQL.", "request")]);
		paths.push(explicit);
		const completed = writeTranscript([
			qoderMeta(),
			...qoderTool("search_replace", "edit-1", { file_path: "/repo/auth.ts" }, "Updated", false),
		]);
		paths.push(completed);
		const cleared = writeTranscript([
			qoderMeta(),
			...qoderTool("create_file", "edit-1", { file_path: "/repo/auth.ts" }, "Created", false),
			...qoderTool(
				"run_in_terminal",
				"write-1",
				{ command: 'agent-memory write --content "staging uses PostgreSQL"' },
				"Appended to daily log: /memory/daily/2026-09-08.md",
				false,
			),
		]);
		paths.push(cleared);
		const explicitCheck = checkCaptureTranscript(explicit, QODER_SESSION);
		const completedCheck = checkCaptureTranscript(completed, QODER_SESSION);
		const clearedCheck = checkCaptureTranscript(cleared, QODER_SESSION);
		return {
			mechanizedExplicitRequest: Boolean(explicitCheck?.pendingSignal),
			mechanizedCompletedWork: Boolean(completedCheck?.pendingSignal),
			mechanizedWriteClearsSignal: clearedCheck !== null && clearedCheck.pendingSignal === undefined,
			notes: [
				"Qoder Stop reads its documented persisted transcript JSONL and blocks with exit 2 when capture is pending.",
				"Qoder native create_file/search_replace edits and run_in_terminal AgentMemory writes are verified deterministically.",
			],
		};
	} finally {
		for (const transcript of paths) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
	}
}

function evaluateCursorMechanism(): Pick<
	CaptureHarnessResult,
	"mechanizedExplicitRequest" | "mechanizedCompletedWork" | "mechanizedWriteClearsSignal" | "notes"
> {
	const initial = { lastSeenAt: 0 };
	const explicit = reduceCursorCaptureEvent(
		initial,
		{
			conversation_id: "cursor-eval-explicit",
			generation_id: "generation-1",
			hook_event_name: "beforeSubmitPrompt",
			prompt: "Remember this: staging uses PostgreSQL.",
		},
		1,
	);
	const negative = reduceCursorCaptureEvent(
		initial,
		{
			conversation_id: "cursor-eval-negative",
			generation_id: "generation-1",
			hook_event_name: "beforeSubmitPrompt",
			prompt: "Do not remember this: staging uses PostgreSQL.",
		},
		1,
	);
	const completed = reduceCursorCaptureEvent(
		initial,
		{
			conversation_id: "cursor-eval-work",
			generation_id: "generation-1",
			hook_event_name: "afterFileEdit",
			file_path: "/repo/auth.ts",
			edits: [{ old_string: "old", new_string: "new" }],
		},
		1,
	);
	const shellCleared = reduceCursorCaptureEvent(
		completed.state,
		{
			conversation_id: "cursor-eval-work",
			generation_id: "generation-1",
			hook_event_name: "afterShellExecution",
			command: 'agent-memory write --content "staging uses PostgreSQL"',
			output: "Appended to daily log: /memory/daily/2026-09-08.md",
		},
		2,
	);
	const mcpCleared = reduceCursorCaptureEvent(
		completed.state,
		{
			conversation_id: "cursor-eval-work",
			generation_id: "generation-1",
			hook_event_name: "afterMCPExecution",
			tool_name: "memory_write",
			mcp_server_name: "agent-memory",
			result_json: JSON.stringify({
				content: [{ type: "text", text: "Appended to daily log: /memory/daily/2026-09-08.md" }],
			}),
		},
		2,
	);
	return {
		mechanizedExplicitRequest: Boolean(explicit.state.pendingSignal) && !negative.state.pendingSignal,
		mechanizedCompletedWork: Boolean(completed.state.pendingSignal),
		mechanizedWriteClearsSignal:
			shellCleared.state.pendingSignal === undefined && mcpCleared.state.pendingSignal === undefined,
		notes: [
			"Cursor local user hooks record explicit requests through beforeSubmitPrompt and completed work through afterFileEdit without relying on an undocumented transcript format.",
			"Verified AgentMemory writes clear pending state through both afterShellExecution and afterMCPExecution; Stop emits Cursor-native followup_message once per signal.",
		],
	};
}

export function runCaptureReliabilityEvaluation(): CaptureReliabilityReport {
	const claudeMechanism = evaluateClaudeMechanism();
	const codexMechanism = evaluateCodexMechanism();
	const qoderMechanism = evaluateQoderMechanism();
	const cursorMechanism = evaluateCursorMechanism();
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
		if (harness === "qoder") {
			return {
				harness,
				enforcement: "mechanized",
				measured: true,
				instructionContract: skillHasCaptureContract(skillPath),
				mechanizedExplicitRequest: qoderMechanism.mechanizedExplicitRequest,
				mechanizedCompletedWork: qoderMechanism.mechanizedCompletedWork,
				mechanizedWriteClearsSignal: qoderMechanism.mechanizedWriteClearsSignal,
				notes: qoderMechanism.notes,
			};
		}
		if (harness === "cursor") {
			return {
				harness,
				enforcement: "mechanized",
				measured: true,
				instructionContract: skillHasCaptureContract(skillPath),
				mechanizedExplicitRequest: cursorMechanism.mechanizedExplicitRequest,
				mechanizedCompletedWork: cursorMechanism.mechanizedCompletedWork,
				mechanizedWriteClearsSignal: cursorMechanism.mechanizedWriteClearsSignal,
				notes: cursorMechanism.notes,
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
		mechanizedExplicitRequestCoverage === 1 &&
		mechanizedImmediateCoverage === 1 &&
		claudeMechanism.mechanizedWriteClearsSignal === true &&
		codexMechanism.mechanizedExplicitRequest === true &&
		codexMechanism.mechanizedCompletedWork === true &&
		codexMechanism.mechanizedWriteClearsSignal === true &&
		qoderMechanism.mechanizedExplicitRequest === true &&
		qoderMechanism.mechanizedCompletedWork === true &&
		qoderMechanism.mechanizedWriteClearsSignal === true &&
		cursorMechanism.mechanizedExplicitRequest === true &&
		cursorMechanism.mechanizedCompletedWork === true &&
		cursorMechanism.mechanizedWriteClearsSignal === true &&
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
