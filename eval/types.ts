export const ISSUE_CLASSIFICATIONS = [
	"bug",
	"risk",
	"missing-capability",
	"product-opportunity",
	"qualitative",
] as const;
export type IssueClassification = (typeof ISSUE_CLASSIFICATIONS)[number];

export const TESTABILITY = ["deterministic", "live-qmd", "qualitative"] as const;
export type Testability = (typeof TESTABILITY)[number];

export const EVALUATORS = ["prompt-routing", "context", "write", "cross-agent", "docs-boundary", "live-qmd"] as const;
export type Evaluator = (typeof EVALUATORS)[number];

export interface FeedbackSource {
	id: string;
	title: string;
	url?: string;
	type: "article" | "discussion" | "repository-review";
}

export interface FeedbackIssue {
	id: string;
	title: string;
	claim: string;
	classification: IssueClassification;
	testability: Testability;
	sourceIds: string[];
	notes?: string;
}

export interface RepeatedText {
	content: string;
	prefix?: string;
	repeat?: number;
	suffix?: string;
}

export interface FixtureFile extends RepeatedText {
	path: string;
}

export interface FixtureWrite {
	target?: "long_term" | "daily" | "topic";
	content: string;
	mode?: "append" | "overwrite";
	sessionId?: string;
	topic?: string;
	date?: string;
	sourceUri?: string;
}

export interface EvalFixture {
	files?: FixtureFile[];
	externalFiles?: FixtureFile[];
	writes?: FixtureWrite[];
	searchResults?: RepeatedText;
}

export interface ProbeOracle {
	requiredMarkers?: string[];
	forbiddenMarkers?: string[];
	maxChars?: number;
	topK?: number;
}

export interface FeedbackProbe {
	id: string;
	issueId: string;
	title: string;
	evaluator: Evaluator;
	requirement: string;
	fixtureId?: string;
	fixture?: EvalFixture;
	query?: string;
	mode?: "keyword" | "semantic" | "deep";
	oracle: ProbeOracle;
	notes?: string;
}

export interface FeedbackDataset {
	version: string;
	description: string;
	license: string;
	sources: FeedbackSource[];
	issues: FeedbackIssue[];
	fixtures: Record<string, EvalFixture>;
	probes: FeedbackProbe[];
}

export type ProbeStatus = "passed" | "failed" | "deferred";

export interface FeedbackProbeResult {
	probeId: string;
	issueId: string;
	title: string;
	status: ProbeStatus;
	evaluator: Evaluator;
	assertions: string[];
	observedChars?: number;
	returnedSources?: string[];
	durationMs: number;
}

export interface IssueVerdict {
	issueId: string;
	title: string;
	classification: IssueClassification;
	verdict: "confirmed" | "not-reproduced" | "mixed" | "deferred";
	passed: number;
	failed: number;
	deferred: number;
}

export interface FeedbackEvalReport {
	schemaVersion: "1";
	datasetVersion: string;
	startedAt: string;
	finishedAt: string;
	liveQmd: boolean;
	probes: FeedbackProbeResult[];
	issues: IssueVerdict[];
}
