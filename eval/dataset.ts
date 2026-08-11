import { EVALUATORS, type FeedbackDataset, ISSUE_CLASSIFICATIONS, TESTABILITY } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

export function validateFeedbackDataset(value: unknown): asserts value is FeedbackDataset {
	assert(value && typeof value === "object", "dataset must be an object");
	const dataset = value as Record<string, unknown>;
	assert(typeof dataset.version === "string" && dataset.version.length > 0, "dataset.version is required");
	assert(typeof dataset.description === "string" && dataset.description.length > 0, "dataset.description is required");
	assert(typeof dataset.license === "string" && dataset.license.length > 0, "dataset.license is required");
	assert(Array.isArray(dataset.sources) && dataset.sources.length > 0, "dataset.sources cannot be empty");
	assert(Array.isArray(dataset.issues) && dataset.issues.length > 0, "dataset.issues cannot be empty");
	assert(dataset.fixtures && typeof dataset.fixtures === "object", "dataset.fixtures is required");
	assert(Array.isArray(dataset.probes) && dataset.probes.length > 0, "dataset.probes cannot be empty");

	const sourceIds = new Set<string>();
	for (const rawSource of dataset.sources) {
		assert(rawSource && typeof rawSource === "object", "source must be an object");
		const source = rawSource as Record<string, unknown>;
		assert(typeof source.id === "string" && source.id.length > 0, "source.id is required");
		assert(!sourceIds.has(source.id), `duplicate source id ${source.id}`);
		sourceIds.add(source.id);
		assert(typeof source.title === "string" && source.title.length > 0, `source ${source.id}: title is required`);
		assert(
			source.type === "article" || source.type === "discussion" || source.type === "repository-review",
			`source ${source.id}: invalid type`,
		);
	}

	const issueIds = new Set<string>();
	for (const rawIssue of dataset.issues) {
		assert(rawIssue && typeof rawIssue === "object", "issue must be an object");
		const issue = rawIssue as Record<string, unknown>;
		assert(typeof issue.id === "string" && issue.id.length > 0, "issue.id is required");
		assert(!issueIds.has(issue.id), `duplicate issue id ${issue.id}`);
		issueIds.add(issue.id);
		assert(typeof issue.title === "string" && issue.title.length > 0, `issue ${issue.id}: title is required`);
		assert(typeof issue.claim === "string" && issue.claim.length > 0, `issue ${issue.id}: claim is required`);
		assert(
			ISSUE_CLASSIFICATIONS.includes(issue.classification as (typeof ISSUE_CLASSIFICATIONS)[number]),
			`issue ${issue.id}: invalid classification`,
		);
		assert(
			TESTABILITY.includes(issue.testability as (typeof TESTABILITY)[number]),
			`issue ${issue.id}: invalid testability`,
		);
		assert(stringArray(issue.sourceIds), `issue ${issue.id}: sourceIds must be a non-empty string array`);
		for (const sourceId of issue.sourceIds) {
			assert(sourceIds.has(sourceId), `issue ${issue.id}: unknown source ${sourceId}`);
		}
	}

	const fixtures = dataset.fixtures as Record<string, unknown>;
	const probeIds = new Set<string>();
	const probedIssues = new Set<string>();
	for (const rawProbe of dataset.probes) {
		assert(rawProbe && typeof rawProbe === "object", "probe must be an object");
		const probe = rawProbe as Record<string, unknown>;
		assert(typeof probe.id === "string" && probe.id.length > 0, "probe.id is required");
		assert(!probeIds.has(probe.id), `duplicate probe id ${probe.id}`);
		probeIds.add(probe.id);
		assert(typeof probe.issueId === "string" && issueIds.has(probe.issueId), `probe ${probe.id}: unknown issue`);
		probedIssues.add(probe.issueId);
		assert(typeof probe.title === "string" && probe.title.length > 0, `probe ${probe.id}: title is required`);
		assert(
			typeof probe.requirement === "string" && probe.requirement.length > 0,
			`probe ${probe.id}: requirement is required`,
		);
		assert(
			EVALUATORS.includes(probe.evaluator as (typeof EVALUATORS)[number]),
			`probe ${probe.id}: invalid evaluator`,
		);
		assert(probe.oracle && typeof probe.oracle === "object", `probe ${probe.id}: oracle is required`);
		const oracle = probe.oracle as Record<string, unknown>;
		if (oracle.requiredMarkers !== undefined) {
			assert(stringArray(oracle.requiredMarkers), `probe ${probe.id}: requiredMarkers must be a string array`);
		}
		if (oracle.forbiddenMarkers !== undefined) {
			assert(stringArray(oracle.forbiddenMarkers), `probe ${probe.id}: forbiddenMarkers must be a string array`);
		}
		if (oracle.maxChars !== undefined) {
			assert(
				typeof oracle.maxChars === "number" && Number.isInteger(oracle.maxChars) && oracle.maxChars > 0,
				`probe ${probe.id}: maxChars must be a positive integer`,
			);
		}
		if (oracle.topK !== undefined) {
			assert(
				typeof oracle.topK === "number" && Number.isInteger(oracle.topK) && oracle.topK > 0 && oracle.topK <= 5,
				`probe ${probe.id}: topK must be an integer from 1 to 5`,
			);
		}
		if (probe.fixtureId !== undefined) {
			assert(
				typeof probe.fixtureId === "string" && probe.fixtureId in fixtures,
				`probe ${probe.id}: unknown fixture`,
			);
		}
		if (probe.evaluator === "live-qmd") {
			assert(typeof probe.query === "string" && probe.query.length > 0, `probe ${probe.id}: query is required`);
			assert(
				probe.mode === "keyword" || probe.mode === "semantic" || probe.mode === "deep",
				`probe ${probe.id}: mode is required`,
			);
		}
	}

	for (const rawIssue of dataset.issues) {
		const issue = rawIssue as Record<string, unknown>;
		if (issue.testability !== "qualitative") {
			assert(
				probedIssues.has(issue.id as string),
				`issue ${issue.id}: non-qualitative issues need at least one probe`,
			);
		}
	}
}

export async function loadFeedbackDataset(input: string | URL): Promise<FeedbackDataset> {
	const parsed: unknown = JSON.parse(await Bun.file(input).text());
	validateFeedbackDataset(parsed);
	return parsed;
}
