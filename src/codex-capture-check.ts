import { createHash } from "node:crypto";
import * as fs from "node:fs";

const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const EDIT_TOOLS = new Set(["apply_patch"]);

type RecordValue = Record<string, unknown>;

export interface CodexCaptureCheck {
	pendingSignal?: string;
}

function record(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function isExplicitMemoryRequest(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const request = value.trim();
	if (!request) return false;
	if (/^(?:<system-reminder>|# (?:AGENTS|CLAUDE)\.md)/.test(request)) return false;
	if (/\b(?:don['’]t|do not|never)\s+remember\b/i.test(request)) return false;
	return /\b(?:remember\s+(?:this|that|to)|don['’]t forget\s+(?:this|that|to))\b/i.test(request);
}

function parseJsonRecord(value: unknown): RecordValue | undefined {
	if (typeof value !== "string") return record(value);
	try {
		return record(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function outputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join("\n");
	const obj = record(value);
	if (!obj) return "";
	for (const key of ["content", "body", "output", "text"] as const) {
		const rendered = outputText(obj[key]);
		if (rendered) return rendered;
	}
	return "";
}

function toolCommand(tool: RecordValue): string {
	const args = parseJsonRecord(tool.arguments ?? tool.input);
	const command = args?.cmd ?? args?.command;
	if (typeof command === "string") return command;
	if (Array.isArray(command)) return command.map(String).join(" ");
	return "";
}

function isMemoryWrite(tool: RecordValue): boolean {
	const name = String(tool.name ?? "");
	if (name === "memory_write" || name.endsWith("__memory_write")) return true;
	if (!["exec_command", "shell", "shell_command"].includes(name)) return false;
	return /^\s*agent-memory\s+(?:write|save)\s/.test(toolCommand(tool));
}

function outputSucceeded(payload: RecordValue): boolean {
	const output = record(payload.output);
	if (payload.success === false || output?.success === false) return false;
	return true;
}

function successfulMemoryWrite(tool: RecordValue, output: RecordValue): boolean {
	if (!isMemoryWrite(tool) || !outputSucceeded(output)) return false;
	const rendered = outputText(output.output).trim();
	if (/(?:^|\n)(?:Appended to (?:daily log|MEMORY\.md|topic):?|Overwrote MEMORY\.md)\b/.test(rendered)) return true;
	try {
		const envelope = record(JSON.parse(rendered));
		return envelope?.ok === true && ["daily", "long_term", "topic"].includes(String(envelope.target));
	} catch {
		return false;
	}
}

function isCompletedEdit(tool: RecordValue, output: RecordValue): boolean {
	return EDIT_TOOLS.has(String(tool.name ?? "")) && outputSucceeded(output);
}

function responseCall(payload: RecordValue): { id: string; tool: RecordValue } | null {
	const type = String(payload.type ?? "");
	if (type !== "function_call" && type !== "custom_tool_call") return null;
	const id = payload.call_id ?? payload.id;
	if (typeof id !== "string" || !id) return null;
	return { id, tool: payload };
}

function responseOutput(payload: RecordValue): { id: string; output: RecordValue } | null {
	const type = String(payload.type ?? "");
	if (type !== "function_call_output" && type !== "custom_tool_call_output") return null;
	const id = payload.call_id ?? payload.id;
	if (typeof id !== "string" || !id) return null;
	return { id, output: payload };
}

/** Parse a Codex rollout JSONL tail using the persisted rollout schema. */
export function checkCodexCaptureTranscript(transcriptPath: unknown, sessionId: string): CodexCaptureCheck | null {
	if (typeof transcriptPath !== "string" || !transcriptPath) return null;
	let fd: number | undefined;
	try {
		fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return null;
		const start = Math.max(0, stat.size - MAX_TRANSCRIPT_BYTES);
		const bytes = Buffer.alloc(Math.min(stat.size, MAX_TRANSCRIPT_BYTES));
		const length = fs.readSync(fd, bytes, 0, bytes.length, start);
		let content = bytes.subarray(0, length).toString("utf8");
		if (start > 0) content = content.slice(content.indexOf("\n") + 1);

		const tools = new Map<string, RecordValue>();
		let pendingSignal: string | undefined;
		let usable = false;
		const signal = (id: string) => createHash("sha256").update(`${sessionId}\n${id}`).digest("hex");

		for (const line of content.split("\n")) {
			let entry: RecordValue | undefined;
			try {
				entry = record(JSON.parse(line));
			} catch {
				continue;
			}
			if (!entry) continue;
			const payload = record(entry.payload);
			if (!payload) continue;

			if (entry.type === "session_meta") {
				const persistedSessionId = payload.session_id ?? payload.id;
				if (typeof persistedSessionId === "string" && persistedSessionId !== sessionId) return null;
				usable = true;
				continue;
			}

			if (entry.type === "event_msg" && payload.type === "user_message") {
				usable = true;
				const message = typeof payload.message === "string" ? payload.message : "";
				if (isExplicitMemoryRequest(message)) pendingSignal = signal(String(entry.ordinal ?? entry.timestamp ?? line));
				continue;
			}

			if (entry.type !== "response_item") continue;
			usable = true;
			const call = responseCall(payload);
			if (call) {
				tools.set(call.id, call.tool);
				continue;
			}
			const result = responseOutput(payload);
			if (!result) continue;
			const tool = tools.get(result.id);
			if (!tool) continue;
			if (isCompletedEdit(tool, result.output)) pendingSignal = signal(result.id);
			if (successfulMemoryWrite(tool, result.output)) pendingSignal = undefined;
		}
		return usable ? { pendingSignal } : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
