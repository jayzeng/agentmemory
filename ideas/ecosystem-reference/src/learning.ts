import type { ScopePath } from "./model.ts";

export type EvidenceRef = `episode://${string}/event/${string}`;

export type EpisodeEvent =
	| {
			id: string;
			type: "tool_call";
			operation: string;
			scopeLayer: string;
	  }
	| {
			id: string;
			type: "correction";
			target: string;
			expectedScopeLayer: string;
			text: string;
	  }
	| {
			id: string;
			type: "validation";
			passed: boolean;
	  };

export interface ExperienceEpisode {
	id: string;
	sessionId: string;
	app: string;
	scope: ScopePath;
	events: EpisodeEvent[];
}

export interface ScopePolicy {
	id: string;
	operation: "find_decision";
	when: { conversationKind: "thread" };
	scopeOrder: readonly ["conversation", "channel", "workspace"];
}

export interface LearningCandidate {
	id: string;
	pattern: "recurring-correction";
	proposedOwner: "app-policy";
	evidenceRefs: EvidenceRef[];
	evidenceStats: {
		independentSessions: number;
		corrections: number;
	};
	policy: ScopePolicy;
}

export interface ReviewPacket {
	allowedEvidenceRefs: ReadonlySet<EvidenceRef>;
	minimumIndependentSessions: number;
	minimumCorrections: number;
}

function evidenceRef(episode: ExperienceEpisode, event: EpisodeEvent): EvidenceRef {
	return `episode://${episode.id}/event/${event.id}`;
}

export function buildReviewPacket(episodes: readonly ExperienceEpisode[]): ReviewPacket {
	const refs = episodes.flatMap((episode) => episode.events.map((event) => evidenceRef(episode, event)));
	return {
		allowedEvidenceRefs: new Set(refs),
		minimumIndependentSessions: 2,
		minimumCorrections: 2,
	};
}

export function detectSlackDecisionCorrections(episodes: readonly ExperienceEpisode[]): LearningCandidate | undefined {
	const matches = episodes.flatMap((episode) =>
		episode.events
			.filter(
				(event): event is Extract<EpisodeEvent, { type: "correction" }> =>
					event.type === "correction" &&
					episode.app === "slack" &&
					event.target === "slack:decision-retrieval" &&
					event.expectedScopeLayer === "conversation" &&
					episode.scope.some((ref) => ref.layer === "conversation" && ref.attributes?.kind === "thread"),
			)
			.map((event) => ({ episode, event })),
	);
	const sessions = new Set(matches.map(({ episode }) => episode.sessionId));
	if (matches.length < 2 || sessions.size < 2) return undefined;

	return {
		id: "candidate:slack-decision-thread-first:v1",
		pattern: "recurring-correction",
		proposedOwner: "app-policy",
		evidenceRefs: matches.map(({ episode, event }) => evidenceRef(episode, event)),
		evidenceStats: {
			independentSessions: sessions.size,
			corrections: matches.length,
		},
		policy: {
			id: "slack:decision-thread-first",
			operation: "find_decision",
			when: { conversationKind: "thread" },
			scopeOrder: ["conversation", "channel", "workspace"],
		},
	};
}

export function validateCandidate(candidate: LearningCandidate, packet: ReviewPacket): void {
	if (candidate.evidenceStats.independentSessions < packet.minimumIndependentSessions) {
		throw new Error("candidate has too few independent sessions");
	}
	if (candidate.evidenceStats.corrections < packet.minimumCorrections) {
		throw new Error("candidate has too few corrections");
	}
	if (candidate.evidenceRefs.length !== candidate.evidenceStats.corrections) {
		throw new Error("candidate evidence count does not match correction count");
	}
	for (const ref of candidate.evidenceRefs) {
		if (!packet.allowedEvidenceRefs.has(ref)) throw new Error(`candidate cites unavailable evidence: ${ref}`);
	}
	if (candidate.policy.scopeOrder.join(",") !== "conversation,channel,workspace") {
		throw new Error("decision retrieval must widen monotonically from conversation to workspace");
	}
}

export interface OverlayEvent {
	seq: number;
	op: "activate" | "revert";
	candidateId: string;
	policyId: string;
}

export interface OverlayState {
	revision: number;
	activePolicies: Readonly<Record<string, ScopePolicy>>;
	journal: readonly OverlayEvent[];
}

export interface OverlayPlan {
	baseRevision: number;
	candidateId: string;
	policy: ScopePolicy;
}

export function planOverlay(state: OverlayState, candidate: LearningCandidate): OverlayPlan {
	return {
		baseRevision: state.revision,
		candidateId: candidate.id,
		policy: candidate.policy,
	};
}

export function applyOverlay(state: OverlayState, plan: OverlayPlan): OverlayState {
	const existing = state.journal.find((event) => event.op === "activate" && event.candidateId === plan.candidateId);
	if (existing) return state;
	if (state.revision !== plan.baseRevision) {
		throw new Error(`revision conflict: planned ${plan.baseRevision}, current ${state.revision}`);
	}

	const revision = state.revision + 1;
	return {
		revision,
		activePolicies: { ...state.activePolicies, [plan.policy.id]: plan.policy },
		journal: [
			...state.journal,
			{
				seq: revision,
				op: "activate",
				candidateId: plan.candidateId,
				policyId: plan.policy.id,
			},
		],
	};
}

export const emptyOverlayState: OverlayState = {
	revision: 0,
	activePolicies: {},
	journal: [],
};
