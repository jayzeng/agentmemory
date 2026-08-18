import { defineApp, type OperationDefinition, type ScopePath } from "./model.ts";

export interface SlackEvent {
	workspaceId: string;
	channelId: string;
	conversation: {
		kind: "channel" | "thread";
		id: string;
	};
	messageId: string;
	text: string;
}

export interface FindDecisionInput {
	query: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requiredString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`Slack event needs ${field}`);
	return value;
}

export function normalizeSlackEvent(input: unknown): SlackEvent {
	if (!isRecord(input)) throw new Error("Slack event must be an object");
	const workspaceId = requiredString(input, "team_id");
	const channelId = requiredString(input, "channel_id");
	const messageId = requiredString(input, "ts");
	const threadId = typeof input.thread_ts === "string" && input.thread_ts.trim() ? input.thread_ts : undefined;

	return {
		workspaceId,
		channelId,
		conversation: threadId ? { kind: "thread", id: threadId } : { kind: "channel", id: `channel:${channelId}` },
		messageId,
		text: typeof input.text === "string" ? input.text : "",
	};
}

const findDecision: OperationDefinition<FindDecisionInput> = {
	id: "find_decision",
	effect: "read",
	onLayer: "conversation",
	validateInput(input: unknown): input is FindDecisionInput {
		return isRecord(input) && typeof input.query === "string" && input.query.trim().length > 0;
	},
};

export const slackApp = defineApp<SlackEvent>({
	id: "slack",
	version: "0.1.0",
	layers: [
		{ id: "workspace", identityFields: ["team_id"] },
		{ id: "channel", parent: "workspace", identityFields: ["channel_id"] },
		{
			id: "conversation",
			parent: "channel",
			identityFields: ["kind", "thread_ts | channel_id"],
		},
		{ id: "message", parent: "conversation", identityFields: ["ts"], terminal: true },
	],
	operations: [findDecision as OperationDefinition<unknown>],
	normalize: normalizeSlackEvent,
	resolveScope(event): ScopePath {
		return [
			{ app: "slack", layer: "workspace", id: event.workspaceId },
			{ app: "slack", layer: "channel", id: event.channelId },
			{
				app: "slack",
				layer: "conversation",
				id: event.conversation.id,
				attributes: { kind: event.conversation.kind },
			},
			{ app: "slack", layer: "message", id: event.messageId },
		];
	},
});
