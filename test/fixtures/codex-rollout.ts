// Shared builders for the Codex persisted-rollout JSONL schema (session_meta /
// response_item envelopes). Both the unit tests and the cross-harness eval
// encode this same schema to exercise checkCodexCaptureTranscript — kept here
// once so a future schema change only needs updating in one place.

export const CODEX_ROLLOUT_SESSION = "11111111-2222-3333-4444-555555555555";

export function codexMeta(sessionId: string = CODEX_ROLLOUT_SESSION): unknown {
	return {
		timestamp: "2026-09-08T22:00:00Z",
		type: "session_meta",
		payload: { session_id: sessionId, id: sessionId, cwd: "/repo", source: "cli" },
	};
}

export function codexCall(
	type: "function_call" | "custom_tool_call",
	name: string,
	callId: string,
	args: unknown,
): unknown {
	return {
		timestamp: "2026-09-08T22:00:01Z",
		type: "response_item",
		payload: { type, name, call_id: callId, arguments: typeof args === "string" ? args : JSON.stringify(args) },
	};
}

export function codexOutput(
	type: "function_call_output" | "custom_tool_call_output",
	callId: string,
	value: unknown,
): unknown {
	return {
		timestamp: "2026-09-08T22:00:03Z",
		type: "response_item",
		payload: { type, call_id: callId, output: value },
	};
}
