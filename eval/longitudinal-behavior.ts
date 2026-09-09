#!/usr/bin/env bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_clearUpdateTimer,
	_getQmdAvailable,
	_resetBaseDir,
	_setBaseDir,
	_setQmdAvailable,
	buildMemoryContext,
	ensureDirs,
	escapeEntryMarkers,
	getMemoryFile,
} from "../src/core.js";

export type LongitudinalCategory =
	| "correction-reuse"
	| "decision-reuse"
	| "preference-reuse"
	| "stale-resistance"
	| "irrelevant-resistance";

export type MemoryLifecycle = "active" | "superseded" | "expired" | "retired" | "untrusted";

export interface LongitudinalHistoryEntry {
	session: string;
	lifecycle: MemoryLifecycle;
	content: string;
}

export interface LongitudinalCandidate {
	id: string;
	cues: string[];
}

export interface LongitudinalTask {
	prompt: string;
	candidates: LongitudinalCandidate[];
	expectedAction: string;
	defaultAction: string;
	staleAction?: string;
}

export interface LongitudinalScenario {
	id: string;
	category: LongitudinalCategory;
	shouldMemoryHelp: boolean;
	probeSessions: number;
	history: LongitudinalHistoryEntry[];
	task: LongitudinalTask;
}

export interface LongitudinalBehaviorDataset {
	version: "longitudinal-behavior-v1";
	description: string;
	scenarios: LongitudinalScenario[];
}

export interface LongitudinalScenarioResult {
	id: string;
	category: LongitudinalCategory;
	shouldMemoryHelp: boolean;
	probeSessions: number;
	expectedAction: string;
	memoryAction: string;
	controlAction: string;
	staleOnlyAction: string;
	memoryCorrect: boolean;
	controlCorrect: boolean;
	staleActionSelected: boolean;
	inappropriateRecall: boolean;
	memoryContextChars: number;
	staleOnlyContextChars: number;
}

export interface LongitudinalBehaviorReport {
	schemaVersion: "longitudinal-behavior-report-v1";
	datasetVersion: "longitudinal-behavior-v1";
	referencePolicy: "cue-match-v1";
	scenarios: LongitudinalScenarioResult[];
	metrics: {
		totalProbeSessions: number;
		helpfulProbeSessions: number;
		silentProbeSessions: number;
		memorySuccessRate: number;
		controlSuccessRate: number;
		absoluteSuccessLift: number;
		helpfulMemorySuccessRate: number;
		helpfulControlSuccessRate: number;
		memoryRepeatedErrorRate: number;
		controlRepeatedErrorRate: number;
		repeatedErrorReduction: number;
		correctionReuseRate: number;
		staleActionRate: number;
		inappropriateRecallRate: number;
	};
	passed: boolean;
	claims: {
		deterministicContract: true;
		liveModelEffectMeasured: false;
	};
}

const DEFAULT_DATASET_URL = new URL("./datasets/longitudinal-behavior-v1.json", import.meta.url);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`invalid longitudinal behavior dataset: ${message}`);
}

const LONGITUDINAL_CATEGORIES: ReadonlySet<LongitudinalCategory> = new Set([
	"correction-reuse",
	"decision-reuse",
	"preference-reuse",
	"stale-resistance",
	"irrelevant-resistance",
]);

export function validateLongitudinalBehaviorDataset(dataset: LongitudinalBehaviorDataset): void {
	assert(dataset?.version === "longitudinal-behavior-v1", "unsupported version");
	assert(Array.isArray(dataset.scenarios) && dataset.scenarios.length >= 6, "expected at least six scenarios");

	const ids = new Set<string>();
	let helpful = 0;
	let silent = 0;
	let inactiveEntries = 0;
	let staleActionScenarios = 0;
	for (const scenario of dataset.scenarios) {
		assert(typeof scenario.id === "string" && scenario.id.length > 0, "scenario id is required");
		assert(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
		ids.add(scenario.id);
		assert(LONGITUDINAL_CATEGORIES.has(scenario.category), `${scenario.id}: unknown category: ${scenario.category}`);
		assert(
			Number.isInteger(scenario.probeSessions) && scenario.probeSessions >= 2,
			`${scenario.id}: probeSessions must be >= 2`,
		);
		assert(Array.isArray(scenario.history) && scenario.history.length > 0, `${scenario.id}: history is required`);
		assert(
			Array.isArray(scenario.task.candidates) && scenario.task.candidates.length >= 2,
			`${scenario.id}: candidates are required`,
		);
		for (const candidate of scenario.task.candidates) {
			assert(
				candidate.cues.every((cue) => cue.trim().length > 0),
				`${scenario.id}: candidate ${candidate.id} has a blank cue`,
			);
		}

		const candidateIds = new Set(scenario.task.candidates.map((candidate) => candidate.id));
		assert(candidateIds.size === scenario.task.candidates.length, `${scenario.id}: candidate ids must be unique`);
		assert(candidateIds.has(scenario.task.expectedAction), `${scenario.id}: expectedAction must name a candidate`);
		assert(candidateIds.has(scenario.task.defaultAction), `${scenario.id}: defaultAction must name a candidate`);
		if (scenario.task.staleAction !== undefined) {
			staleActionScenarios++;
			assert(candidateIds.has(scenario.task.staleAction), `${scenario.id}: staleAction must name a candidate`);
			assert(
				scenario.task.staleAction !== scenario.task.expectedAction,
				`${scenario.id}: staleAction must differ from expectedAction`,
			);
		}
		if (scenario.shouldMemoryHelp) {
			helpful++;
			assert(
				scenario.task.expectedAction !== scenario.task.defaultAction,
				`${scenario.id}: helpful scenarios need a non-default expected action`,
			);
		} else {
			silent++;
			assert(
				scenario.task.expectedAction === scenario.task.defaultAction,
				`${scenario.id}: silent scenarios must keep the default action`,
			);
		}
		for (const entry of scenario.history) {
			assert(
				typeof entry.session === "string" && entry.session.length > 0,
				`${scenario.id}: history session is required`,
			);
			assert(
				typeof entry.content === "string" && entry.content.trim().length > 0,
				`${scenario.id}: history content is required`,
			);
			if (entry.lifecycle !== "active") inactiveEntries++;
		}
	}
	assert(helpful >= 3, "expected multiple memory-help scenarios");
	assert(silent >= 2, "expected stale or irrelevant resistance controls");
	assert(inactiveEntries >= 3, "expected multiple inactive-memory controls");
	assert(staleActionScenarios >= 1, "expected at least one scenario with a staleAction for stale-resistance coverage");
}

export function loadLongitudinalBehaviorDataset(url: URL = DEFAULT_DATASET_URL): LongitudinalBehaviorDataset {
	const dataset = JSON.parse(fs.readFileSync(url, "utf8")) as LongitudinalBehaviorDataset;
	validateLongitudinalBehaviorDataset(dataset);
	return dataset;
}

function lifecycleHeader(lifecycle: MemoryLifecycle): string | undefined {
	if (lifecycle === "superseded") return "Status: superseded";
	if (lifecycle === "expired") return "Status: expired";
	if (lifecycle === "retired") return "Status: retired";
	if (lifecycle === "untrusted") return "Trust: untrusted";
	return undefined;
}

function renderHistory(history: LongitudinalHistoryEntry[]): string {
	return history
		.map((entry, index) => {
			const day = String(index + 1).padStart(2, "0");
			const marker = `<!-- 2026-01-${day} 12:00:00 [${entry.session}] -->`;
			const header = lifecycleHeader(entry.lifecycle);
			return [marker, header, escapeEntryMarkers(entry.content)].filter(Boolean).join("\n");
		})
		.join("\n\n");
}

function buildIsolatedContext(history: LongitudinalHistoryEntry[]): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-longitudinal-"));
	const previousQmd = _getQmdAvailable();
	try {
		_setBaseDir(tmpDir);
		_setQmdAvailable(false);
		ensureDirs();
		if (history.length > 0) fs.writeFileSync(getMemoryFile(), `${renderHistory(history)}\n`, "utf8");
		return buildMemoryContext("");
	} finally {
		_clearUpdateTimer();
		_resetBaseDir();
		_setQmdAvailable(previousQmd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Deterministic downstream reference policy. It is deliberately simple: the
 * candidate with the most explicit memory cues wins; ties and no-evidence cases
 * fall back to the task's declared default action.
 */
export function selectReferenceAction(task: LongitudinalTask, memoryContext: string): string {
	const context = memoryContext.toLowerCase();
	let bestScore = 0;
	let winners: string[] = [];
	for (const candidate of task.candidates) {
		const score = candidate.cues.reduce((total, cue) => {
			const trimmedCue = cue.trim();
			return total + (trimmedCue && context.includes(trimmedCue.toLowerCase()) ? 1 : 0);
		}, 0);
		if (score > bestScore) {
			bestScore = score;
			winners = [candidate.id];
		} else if (score > 0 && score === bestScore) {
			winners.push(candidate.id);
		}
	}
	return bestScore > 0 && winners.length === 1 ? winners[0] : task.defaultAction;
}

function weightedRate(
	results: LongitudinalScenarioResult[],
	predicate: (result: LongitudinalScenarioResult) => boolean,
	filter: (result: LongitudinalScenarioResult) => boolean = () => true,
): number {
	let numerator = 0;
	let denominator = 0;
	for (const result of results) {
		if (!filter(result)) continue;
		denominator += result.probeSessions;
		if (predicate(result)) numerator += result.probeSessions;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

export function runLongitudinalBehaviorEvaluation(
	dataset: LongitudinalBehaviorDataset = loadLongitudinalBehaviorDataset(),
): LongitudinalBehaviorReport {
	validateLongitudinalBehaviorDataset(dataset);
	const scenarios = dataset.scenarios.map<LongitudinalScenarioResult>((scenario) => {
		const memoryContext = buildIsolatedContext(scenario.history);
		const staleOnlyContext = buildIsolatedContext(scenario.history.filter((entry) => entry.lifecycle !== "active"));
		const memoryAction = selectReferenceAction(scenario.task, memoryContext);
		const controlAction = selectReferenceAction(scenario.task, "");
		const staleOnlyAction = selectReferenceAction(scenario.task, staleOnlyContext);
		return {
			id: scenario.id,
			category: scenario.category,
			shouldMemoryHelp: scenario.shouldMemoryHelp,
			probeSessions: scenario.probeSessions,
			expectedAction: scenario.task.expectedAction,
			memoryAction,
			controlAction,
			staleOnlyAction,
			memoryCorrect: memoryAction === scenario.task.expectedAction,
			controlCorrect: controlAction === scenario.task.expectedAction,
			staleActionSelected: Boolean(scenario.task.staleAction && staleOnlyAction === scenario.task.staleAction),
			inappropriateRecall: !scenario.shouldMemoryHelp && memoryAction !== scenario.task.defaultAction,
			memoryContextChars: memoryContext.length,
			staleOnlyContextChars: staleOnlyContext.length,
		};
	});

	const totalProbeSessions = scenarios.reduce((sum, result) => sum + result.probeSessions, 0);
	const helpfulProbeSessions = scenarios
		.filter((result) => result.shouldMemoryHelp)
		.reduce((sum, result) => sum + result.probeSessions, 0);
	const silentProbeSessions = totalProbeSessions - helpfulProbeSessions;
	const memorySuccessRate = weightedRate(scenarios, (result) => result.memoryCorrect);
	const controlSuccessRate = weightedRate(scenarios, (result) => result.controlCorrect);
	const helpfulMemorySuccessRate = weightedRate(
		scenarios,
		(result) => result.memoryCorrect,
		(result) => result.shouldMemoryHelp,
	);
	const helpfulControlSuccessRate = weightedRate(
		scenarios,
		(result) => result.controlCorrect,
		(result) => result.shouldMemoryHelp,
	);
	const memoryRepeatedErrorRate = 1 - helpfulMemorySuccessRate;
	const controlRepeatedErrorRate = 1 - helpfulControlSuccessRate;
	const repeatedErrorReduction = controlRepeatedErrorRate - memoryRepeatedErrorRate;
	const correctionReuseRate = weightedRate(
		scenarios,
		(result) => result.memoryCorrect,
		(result) => result.category === "correction-reuse",
	);
	const staleActionRate = weightedRate(
		scenarios,
		(result) => result.staleActionSelected,
		(result) => dataset.scenarios.find((scenario) => scenario.id === result.id)?.task.staleAction !== undefined,
	);
	const inappropriateRecallRate = weightedRate(
		scenarios,
		(result) => result.inappropriateRecall,
		(result) => !result.shouldMemoryHelp,
	);
	const metrics = {
		totalProbeSessions,
		helpfulProbeSessions,
		silentProbeSessions,
		memorySuccessRate,
		controlSuccessRate,
		absoluteSuccessLift: memorySuccessRate - controlSuccessRate,
		helpfulMemorySuccessRate,
		helpfulControlSuccessRate,
		memoryRepeatedErrorRate,
		controlRepeatedErrorRate,
		repeatedErrorReduction,
		correctionReuseRate,
		staleActionRate,
		inappropriateRecallRate,
	};
	const passed =
		totalProbeSessions >= 20 &&
		helpfulMemorySuccessRate === 1 &&
		helpfulControlSuccessRate === 0 &&
		correctionReuseRate === 1 &&
		staleActionRate === 0 &&
		inappropriateRecallRate === 0 &&
		memorySuccessRate > controlSuccessRate &&
		repeatedErrorReduction === 1;

	return {
		schemaVersion: "longitudinal-behavior-report-v1",
		datasetVersion: dataset.version,
		referencePolicy: "cue-match-v1",
		scenarios,
		metrics,
		passed,
		claims: {
			deterministicContract: true,
			liveModelEffectMeasured: false,
		},
	};
}

if (import.meta.main) {
	const report = runLongitudinalBehaviorEvaluation();
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (!report.passed) process.exitCode = 1;
}
