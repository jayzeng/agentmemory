import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkCaptureTranscript } from "../src/capture-check.js";
import { checkCodexCaptureTranscript } from "../src/codex-capture-check.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

function writeRollout(items: unknown[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-codex-rollout-"));
	const file = path.join(dir, "rollout.jsonl");
	fs.writeFileSync(file, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
	return file;
}

function meta(sessionId = SESSION): unknown {
	return { timestamp: "2026-09-08T22:00:00Z", type: "session_meta", payload: { session_id: sessionId, id: sessionId, cwd: "/repo", source: "cli" } };
}

function user(message: string): unknown {
	return { timestamp: "2026-09-08T22:00:01Z", ordinal: 1, type: "event_msg", payload: { type: "user_message", message, kind: "plain" } };
}

function call(type: "function_call" | "custom_tool_call", name: string, callId: string, args: unknown): unknown {
	return { timestamp: "2026-09-08T22:00:02Z", type: "response_item", payload: { type, name, call_id: callId, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

function output(type: "function_call_output" | "custom_tool_call_output", callId: string, value: unknown): unknown {
	return { timestamp: "2026-09-08T22:00:03Z", type: "response_item", payload: { type, call_id: callId, output: value } };
}

describe("Codex rollout capture parser", () => {
	test("detects explicit memory requests in event_msg user records", () => {
		const file = writeRollout([meta(), user("Remember this: staging uses PostgreSQL.")]);
		try {
			expect(checkCodexCaptureTranscript(file, SESSION)?.pendingSignal).toBeTruthy();
			expect(checkCaptureTranscript(file, SESSION)?.pendingSignal).toBeTruthy();
		} finally {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		}
	});

	test("detects a successful apply_patch as completed work", () => {
		const file = writeRollout([
			meta(),
			call("custom_tool_call", "apply_patch", "patch-1", "*** Begin Patch\n*** End Patch"),
			output("custom_tool_call_output", "patch-1", { content: "Done!", success: true }),
		]);
		try {
			expect(checkCaptureTranscript(file, SESSION)?.pendingSignal).toBeTruthy();
		} finally {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		}
	});

	test("does not treat failed apply_patch output as completed work", () => {
		const file = writeRollout([
			meta(),
			call("custom_tool_call", "apply_patch", "patch-1", "*** Begin Patch\n*** End Patch"),
			output("custom_tool_call_output", "patch-1", { content: "verification failed", success: false }),
		]);
		try {
			expect(checkCaptureTranscript(file, SESSION)?.pendingSignal).toBeUndefined();
		} finally {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		}
	});

	test("a verified agent-memory write clears prior Codex capture work", () => {
		const file = writeRollout([
			meta(),
			call("custom_tool_call", "apply_patch", "patch-1", "*** Begin Patch\n*** End Patch"),
			output("custom_tool_call_output", "patch-1", { content: "Done!", success: true }),
			call("function_call", "exec_command", "write-1", { cmd: 'agent-memory write --content "staging uses PostgreSQL"' }),
			output("function_call_output", "write-1", { content: "Chunk ID: abc\nProcess exited with code 0\nFinal output:\nAppended to daily log: /memory/daily/2026-09-08.md", success: true }),
		]);
		try {
			expect(checkCaptureTranscript(file, SESSION)?.pendingSignal).toBeUndefined();
		} finally {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		}
	});

	test("fails closed when rollout session metadata belongs to another session", () => {
		const file = writeRollout([meta("different-session"), user("Remember this: staging uses PostgreSQL.")]);
		try {
			expect(checkCodexCaptureTranscript(file, SESSION)).toBeNull();
		} finally {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		}
	});
});
