import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { checkCodexCaptureTranscript } from "./codex-capture-check.js";

const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "create_file", "search_replace", "edit_file"]);

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => (record(part)?.type === "text" ? String(record(part)?.text ?? "") : "")).join("\n");
}

export function isExplicitMemoryRequest(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const request = value.trim();
	if (!request) return false;
	if (/^(?:<system-reminder>|# (?:AGENTS|CLAUDE)\.md)/.test(request)) return false;
	if (/\b(?:don['’]t|do not|never)\s+remember\b/i.test(request)) return false;
	return /\b(?:remember\s+(?:this|that|to)|don['’]t forget\s+(?:this|that|to))\b/i.test(request);
}

function isMemoryWrite(tool: RecordValue): boolean {
	const name = String(tool.name ?? "");
	if (name === "memory_write" || name.endsWith("__memory_write")) return true;
	if (!["Bash", "run_in_terminal"].includes(name)) return false;
	const command = record(tool.input)?.command;
	return typeof command === "string" && /^\s*agent-memory\s+(?:write|save)\s/.test(command);
}

function successfulMemoryWrite(tool: RecordValue, result: RecordValue): boolean {
	if (!isMemoryWrite(tool) || result.is_error === true) return false;
	const output = text(result.content).trim();
	if (/^(?:Appended to (?:daily log|MEMORY\.md|topic):?|Overwrote MEMORY\.md)\b/.test(output)) return true;
	try {
		const envelope = record(JSON.parse(output));
		return envelope?.ok === true && ["daily", "long_term", "topic"].includes(String(envelope.target));
	} catch {
		return false;
	}
}

export interface CaptureCheck {
	pendingSignal?: string;
}

/**
 * Detect high-confidence capture opportunities, not the semantic quality of a write.
 * null means no usable transcript: callers can retain their periodic fallback.
 * Supports Claude Code / Qoder content-block JSONL and Codex persisted rollout JSONL.
 */
export function checkCaptureTranscript(transcriptPath: unknown, sessionId: string): CaptureCheck | null {
	const codex = checkCodexCaptureTranscript(transcriptPath, sessionId);
	if (codex !== null) return codex;
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
		for (const line of content.split("\n")) {
			let entry: RecordValue | undefined;
			try {
				entry = record(JSON.parse(line));
			} catch {
				continue;
			}
			if (!entry || entry.isSidechain === true || (entry.sessionId !== undefined && entry.sessionId !== sessionId))
				continue;
			if (entry.type !== "user" && entry.type !== "assistant") continue;
			const message = record(entry.message);
			if (!message) continue;
			usable = true;
			const signal = (id: string) => createHash("sha256").update(`${sessionId}\n${id}`).digest("hex");
			if (entry.type === "user" && entry.isMeta !== true) {
				const request = text(message.content);
				if (isExplicitMemoryRequest(request)) pendingSignal = signal(String(entry.uuid ?? line));
			}
			if (!Array.isArray(message.content)) continue;
			for (const part of message.content) {
				const block = record(part);
				if (!block) continue;
				if (entry.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
					tools.set(block.id, block);
				} else if (entry.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
					const tool = tools.get(block.tool_use_id);
					if (!tool || block.is_error === true) continue;
					if (EDIT_TOOLS.has(String(tool.name))) pendingSignal = signal(block.tool_use_id);
					if (successfulMemoryWrite(tool, block)) pendingSignal = undefined;
				}
			}
		}
		return usable ? { pendingSignal } : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
