import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadFeedbackDataset, validateFeedbackDataset } from "../eval/dataset.js";
import { buildFixtureWriteParams, runFeedbackEvaluation } from "../eval/run.js";

const datasetUrl = new URL("../eval/datasets/external-feedback-v1.json", import.meta.url);

describe("external feedback evaluation dataset", () => {
	test("covers every automatable issue with unique, valid probes", async () => {
		const dataset = await loadFeedbackDataset(datasetUrl);
		const probeIds = dataset.probes.map((probe) => probe.id);
		const probedIssues = new Set(dataset.probes.map((probe) => probe.issueId));

		expect(dataset.version).toBe("external-feedback-v1");
		expect(new Set(probeIds).size).toBe(probeIds.length);
		for (const issue of dataset.issues.filter((issue) => issue.testability !== "qualitative")) {
			expect(probedIssues.has(issue.id)).toBe(true);
		}
	});

	test("contains multilingual controls and adversarial lifecycle evidence", async () => {
		const dataset = await loadFeedbackDataset(datasetUrl);
		const multilingual = dataset.probes.filter((probe) => probe.issueId === "multilingual-retrieval");
		const serialized = JSON.stringify(dataset);

		expect(multilingual.some((probe) => probe.query?.includes("Harbor が"))).toBe(true);
		expect(multilingual.some((probe) => probe.query?.includes("变更 Harbor"))).toBe(true);
		expect(multilingual.some((probe) => probe.mode === "keyword")).toBe(true);
		expect(serialized).toContain("superseded");
		expect(serialized).toContain("expired");
		expect(serialized).toContain("untrusted");
		expect(serialized).toContain("[REDACTED_SECRET]");
	});

	test("rejects invalid retrieval cutoffs", async () => {
		const dataset = await loadFeedbackDataset(datasetUrl);
		const invalid = structuredClone(dataset);
		const liveProbe = invalid.probes.find((probe) => probe.evaluator === "live-qmd");
		expect(liveProbe).toBeDefined();
		if (liveProbe) liveProbe.oracle.topK = 0;
		expect(() => validateFeedbackDataset(invalid)).toThrow("topK must be an integer from 1 to 5");
	});

	test("passes source provenance through to the public write contract", () => {
		const params = buildFixtureWriteParams({
			content: "Use PostgreSQL for Harbor metadata.",
			sourceUri: "session://claude/session-421/turn/18",
		});

		expect(params.sourceUri).toBe("session://claude/session-421/turn/18");
	});

	test("runs deterministic probes in isolated memory directories", async () => {
		const dataset = await loadFeedbackDataset(datasetUrl);
		const report = await runFeedbackEvaluation({ dataset: datasetUrl });
		const results = new Map(report.probes.map((probe) => [probe.probeId, probe]));
		const deterministicIds = dataset.probes
			.filter((probe) => probe.evaluator !== "live-qmd")
			.map((probe) => probe.id);
		const liveIds = dataset.probes.filter((probe) => probe.evaluator === "live-qmd").map((probe) => probe.id);

		for (const probeId of deterministicIds) expect(results.get(probeId)?.status).not.toBe("deferred");
		for (const probeId of liveIds) expect(results.get(probeId)?.status).toBe("deferred");
		expect(results.get("explicit-cross-agent-handoff")?.status).toBe("passed");
		expect(report.probes).toHaveLength(dataset.probes.length);
		expect(report.issues).toHaveLength(dataset.issues.length);
		expect(results.get("prompt-query-routing")?.status).toBe("passed");
		expect(results.get("unrecorded-transcript-import")?.status).toBe("failed");
	});

	test("invalidates a requested live qmd run when setup cannot run", async () => {
		const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-missing-qmd-"));
		const previousPath = process.env.PATH;
		process.env.PATH = emptyPath;
		try {
			await expect(runFeedbackEvaluation({ dataset: datasetUrl, liveQmd: true })).rejects.toThrow(
				"live qmd setup failed:",
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			fs.rmSync(emptyPath, { recursive: true, force: true });
		}
	});
});
