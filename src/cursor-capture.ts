import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { isExplicitMemoryRequest } from "./capture-check.js";
import { getMemoryDir } from "./core.js";

type RecordValue = Record<string, unknown>;

const STATE_VERSION = 1;
const MAX_SESSION_FILES = 256;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CursorCaptureSessionState {
	pendingSignal?: string;
	lastNudgedSignal?: string;
	lastSeenAt: number;
}

interface CursorCaptureStateFile {
	version: 1;
	state: CursorCaptureSessionState;
}

export interface CursorCaptureEventResult {
	state: CursorCaptureSessionState;
	changed: boolean;
	shouldFollowup: boolean;
}

function record(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function signal(conversationId: string, kind: string, identity: string): string {
	return hash(`${conversationId}\n${kind}\n${identity}`);
}

function renderedText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(renderedText).filter(Boolean).join("\n");
	const obj = record(value);
	if (!obj) return "";
	return ["text", "content", "output", "result", "message"]
		.map((key) => renderedText(obj[key]))
		.filter(Boolean)
		.join("\n");
}

function hasVerifiedReceipt(value: unknown): boolean {
	const text = renderedText(value).trim();
	if (/(?:^|\n)(?:Appended to (?:daily log|MEMORY\.md|topic):?|Overwrote MEMORY\.md)\b/.test(text)) return true;
	try {
		const envelope = record(typeof value === "string" ? JSON.parse(value) : value);
		if (envelope?.ok === true && ["daily", "long_term", "topic"].includes(String(envelope.target))) return true;
	} catch {}
	return false;
}

function shellWriteSucceeded(payload: RecordValue): boolean {
	const command = typeof payload.command === "string" ? payload.command : "";
	if (!/^\s*agent-memory\s+(?:write|save)(?:\s|$)/.test(command)) return false;
	return hasVerifiedReceipt(payload.output);
}

function mcpWriteSucceeded(payload: RecordValue): boolean {
	const toolName = String(payload.tool_name ?? "");
	if (toolName !== "memory_write" && !toolName.endsWith("__memory_write")) return false;
	const result = payload.result_json;
	if (typeof result !== "string") return hasVerifiedReceipt(result);
	try {
		return hasVerifiedReceipt(JSON.parse(result));
	} catch {
		return hasVerifiedReceipt(result);
	}
}

/**
 * Pure Cursor capture reducer. It relies only on Cursor's documented hook inputs,
 * not its transcript file format.
 */
export function reduceCursorCaptureEvent(
	current: CursorCaptureSessionState,
	payload: RecordValue,
	now = Date.now(),
): CursorCaptureEventResult {
	const conversationId =
		typeof payload.conversation_id === "string"
			? payload.conversation_id
			: typeof payload.session_id === "string"
				? payload.session_id
				: "";
	if (!conversationId) return { state: current, changed: false, shouldFollowup: false };

	const event = String(payload.hook_event_name ?? "");
	const next: CursorCaptureSessionState = { ...current, lastSeenAt: now };
	let changed = current.lastSeenAt !== now;
	let shouldFollowup = false;

	if (event === "beforeSubmitPrompt") {
		const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
		if (isExplicitMemoryRequest(prompt)) {
			const identity = String(payload.generation_id ?? prompt);
			const pendingSignal = signal(conversationId, "prompt", identity);
			if (next.pendingSignal !== pendingSignal) {
				next.pendingSignal = pendingSignal;
				changed = true;
			}
		}
	} else if (event === "afterFileEdit") {
		const filePath = typeof payload.file_path === "string" ? payload.file_path : "";
		if (filePath) {
			const identity = `${String(payload.generation_id ?? "")}\n${filePath}\n${JSON.stringify(payload.edits ?? [])}`;
			const pendingSignal = signal(conversationId, "file-edit", identity);
			if (next.pendingSignal !== pendingSignal) {
				next.pendingSignal = pendingSignal;
				changed = true;
			}
		}
	} else if (event === "afterShellExecution") {
		if (shellWriteSucceeded(payload) && next.pendingSignal !== undefined) {
			next.pendingSignal = undefined;
			changed = true;
		}
	} else if (event === "afterMCPExecution") {
		if (mcpWriteSucceeded(payload) && next.pendingSignal !== undefined) {
			next.pendingSignal = undefined;
			changed = true;
		}
	} else if (event === "stop") {
		if (payload.status === "completed" && next.pendingSignal && next.lastNudgedSignal !== next.pendingSignal) {
			next.lastNudgedSignal = next.pendingSignal;
			changed = true;
			shouldFollowup = true;
		}
	}

	return { state: next, changed, shouldFollowup };
}

function stateDir(): string {
	return path.join(getMemoryDir(), "cursor-capture");
}

function statePath(conversationId: string): string {
	return path.join(stateDir(), `${hash(conversationId)}.json`);
}

function readState(conversationId: string, now: number): CursorCaptureSessionState {
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath(conversationId), "utf8")) as Partial<CursorCaptureStateFile>;
		if (parsed.version !== STATE_VERSION || !parsed.state || typeof parsed.state !== "object")
			return { lastSeenAt: now };
		return parsed.state;
	} catch {
		return { lastSeenAt: now };
	}
}

function pruneStateDir(now: number): void {
	try {
		const dir = stateDir();
		if (!fs.existsSync(dir)) return;
		const files = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				const file = path.join(dir, name);
				const stat = fs.statSync(file);
				return { file, mtimeMs: stat.mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const [index, entry] of files.entries()) {
			if (index >= MAX_SESSION_FILES || now - entry.mtimeMs > SESSION_TTL_MS) fs.rmSync(entry.file, { force: true });
		}
	} catch {
		// Cleanup is best-effort and must never affect capture.
	}
}

function writeState(conversationId: string, state: CursorCaptureSessionState): void {
	const file = statePath(conversationId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify({ version: STATE_VERSION, state })}\n`, "utf8");
	fs.renameSync(temp, file);
}

/** Persist one Cursor hook event and return whether Stop should auto-follow up. Never throws. */
export function handleCursorCaptureEvent(payload: unknown, now = Date.now()): { shouldFollowup: boolean } {
	try {
		const event = record(payload);
		if (!event) return { shouldFollowup: false };
		const conversationId =
			typeof event.conversation_id === "string"
				? event.conversation_id
				: typeof event.session_id === "string"
					? event.session_id
					: "";
		if (!conversationId) return { shouldFollowup: false };
		pruneStateDir(now);
		const current = readState(conversationId, now);
		const result = reduceCursorCaptureEvent(current, event, now);
		if (result.changed) writeState(conversationId, result.state);
		return { shouldFollowup: result.shouldFollowup };
	} catch {
		return { shouldFollowup: false };
	}
}
