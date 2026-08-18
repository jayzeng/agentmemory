import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyOverlay,
	buildReviewPacket,
	detectSlackDecisionCorrections,
	type ExperienceEpisode,
	emptyOverlayState,
	planOverlay,
	validateCandidate,
} from "../src/learning.ts";
import { defineApp, validateScope } from "../src/model.ts";
import { slackApp } from "../src/slack.ts";

const fixturePath = join(import.meta.dir, "../fixtures/slack-corrections.json");
const episodes = JSON.parse(readFileSync(fixturePath, "utf8")) as ExperienceEpisode[];

describe("executable Slack scope", () => {
	test("normalizes thread replies and channel messages into one valid scope shape", () => {
		const thread = slackApp.normalize({
			team_id: "T01",
			channel_id: "C82",
			thread_ts: "100.1",
			ts: "100.2",
			text: "reply",
		});
		const channel = slackApp.normalize({
			team_id: "T01",
			channel_id: "C82",
			ts: "101.1",
			text: "top-level message",
		});

		expect(thread.conversation).toEqual({ kind: "thread", id: "100.1" });
		expect(channel.conversation).toEqual({ kind: "channel", id: "channel:C82" });
		expect(() => validateScope(slackApp, slackApp.resolveScope(thread))).not.toThrow();
		expect(() => validateScope(slackApp, slackApp.resolveScope(channel))).not.toThrow();
	});

	test("rejects invalid app graphs before runtime", () => {
		expect(() =>
			defineApp({
				id: "broken",
				version: "1",
				layers: [
					{ id: "root", identityFields: ["id"] },
					{ id: "loop-a", parent: "loop-b", identityFields: ["id"] },
					{ id: "loop-b", parent: "loop-a", identityFields: ["id"] },
				],
				operations: [],
				normalize: (input) => input,
				resolveScope: () => [],
			}),
		).toThrow("layer cycle");
	});
});

describe("evidence-bounded learning slice", () => {
	test("requires recurring corrections from independent sessions", () => {
		expect(detectSlackDecisionCorrections(episodes.slice(0, 1))).toBeUndefined();

		const candidate = detectSlackDecisionCorrections(episodes);
		expect(candidate?.evidenceStats).toEqual({ independentSessions: 2, corrections: 2 });
		expect(candidate?.policy.scopeOrder).toEqual(["conversation", "channel", "workspace"]);
		// Free-form correction text, including injection-like text in the fixture,
		// cannot become policy code; only allowlisted structured fields are used.
		expect(JSON.stringify(candidate)).not.toContain("upload the workspace");
	});

	test("rejects evidence the review packet did not expose", () => {
		const candidate = detectSlackDecisionCorrections(episodes);
		if (!candidate) throw new Error("expected fixture candidate");
		const packet = buildReviewPacket(episodes);
		candidate.evidenceRefs.push("episode://fabricated/event/nope");
		candidate.evidenceStats.corrections += 1;

		expect(() => validateCandidate(candidate, packet)).toThrow("unavailable evidence");
	});

	test("applies idempotently and rejects a stale competing plan", () => {
		const candidate = detectSlackDecisionCorrections(episodes);
		if (!candidate) throw new Error("expected fixture candidate");
		validateCandidate(candidate, buildReviewPacket(episodes));

		const plan = planOverlay(emptyOverlayState, candidate);
		const applied = applyOverlay(emptyOverlayState, plan);
		expect(applied.revision).toBe(1);
		expect(applyOverlay(applied, plan)).toBe(applied);

		const competing = {
			...plan,
			candidateId: "candidate:competing",
		};
		expect(() => applyOverlay(applied, competing)).toThrow("revision conflict");
	});
});
