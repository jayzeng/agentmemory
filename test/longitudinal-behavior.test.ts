import { describe, expect, test } from "bun:test";

import {
	loadLongitudinalBehaviorDataset,
	runLongitudinalBehaviorEvaluation,
	selectReferenceAction,
	validateLongitudinalBehaviorDataset,
} from "../eval/longitudinal-behavior.js";

describe("longitudinal behavior evaluation", () => {
	test("shows paired benefit without stale or irrelevant memory harm", () => {
		const report = runLongitudinalBehaviorEvaluation();

		expect(report.passed).toBe(true);
		expect(report.schemaVersion).toBe("longitudinal-behavior-report-v1");
		expect(report.datasetVersion).toBe("longitudinal-behavior-v1");
		expect(report.referencePolicy).toBe("cue-match-v1");
		expect(report.claims).toEqual({ deterministicContract: true, liveModelEffectMeasured: false });

		expect(report.metrics.totalProbeSessions).toBe(21);
		expect(report.metrics.helpfulProbeSessions).toBe(15);
		expect(report.metrics.silentProbeSessions).toBe(6);
		expect(report.metrics.memorySuccessRate).toBe(1);
		expect(report.metrics.controlSuccessRate).toBeCloseTo(2 / 7, 12);
		expect(report.metrics.absoluteSuccessLift).toBeCloseTo(5 / 7, 12);
		expect(report.metrics.helpfulMemorySuccessRate).toBe(1);
		expect(report.metrics.helpfulControlSuccessRate).toBe(0);
		expect(report.metrics.memoryRepeatedErrorRate).toBe(0);
		expect(report.metrics.controlRepeatedErrorRate).toBe(1);
		expect(report.metrics.repeatedErrorReduction).toBe(1);
		expect(report.metrics.correctionReuseRate).toBe(1);
		expect(report.metrics.staleActionRate).toBe(0);
		expect(report.metrics.inappropriateRecallRate).toBe(0);
	});

	test("uses active corrections while suppressing superseded evidence", () => {
		const report = runLongitudinalBehaviorEvaluation();
		const packageManager = report.scenarios.find((scenario) => scenario.id === "correction-package-manager");
		const endpoint = report.scenarios.find((scenario) => scenario.id === "correction-api-endpoint");
		const region = report.scenarios.find((scenario) => scenario.id === "correction-deploy-region");

		expect(packageManager?.memoryAction).toBe("pnpm");
		expect(packageManager?.controlAction).toBe("ask");
		expect(packageManager?.staleOnlyAction).toBe("ask");
		expect(endpoint?.memoryAction).toBe("v3");
		expect(endpoint?.staleOnlyAction).toBe("ask");
		expect(region?.memoryAction).toBe("west");
		expect(region?.staleOnlyAction).toBe("ask");
	});

	test("keeps retired, untrusted, and irrelevant memory from changing behavior", () => {
		const report = runLongitudinalBehaviorEvaluation();
		for (const id of ["retired-feature-flag", "untrusted-build-command", "irrelevant-database-memory"]) {
			const scenario = report.scenarios.find((entry) => entry.id === id);
			expect(scenario?.memoryAction).toBe("ask");
			expect(scenario?.inappropriateRecall).toBe(false);
		}
	});

	test("reference policy fails closed on no evidence and ties", () => {
		const task = {
			prompt: "choose",
			candidates: [
				{ id: "a", cues: ["alpha"] },
				{ id: "b", cues: ["beta"] },
				{ id: "ask", cues: [] },
			],
			expectedAction: "a",
			defaultAction: "ask",
		};
		expect(selectReferenceAction(task, "")).toBe("ask");
		expect(selectReferenceAction(task, "alpha beta")).toBe("ask");
		expect(selectReferenceAction(task, "alpha")).toBe("a");
	});

	test("rejects a helpful scenario whose oracle is already the default", () => {
		const dataset = structuredClone(loadLongitudinalBehaviorDataset());
		dataset.scenarios[0].task.defaultAction = dataset.scenarios[0].task.expectedAction;
		expect(() => validateLongitudinalBehaviorDataset(dataset)).toThrow(
			"helpful scenarios need a non-default expected action",
		);
	});
});
