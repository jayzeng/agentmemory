import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const onboarding = readFileSync(new URL("../docs/onboarding.md", import.meta.url), "utf8");

describe("public support contract", () => {
	test("documents the merged mechanized capture matrix without overstating Pi", () => {
		for (const host of ["Claude Code", "Codex", "Cursor", "Qoder"]) {
			expect(readme).toContain(`| ${host} |`);
		}
		expect(readme).toContain("Pi | Delegated to the separately versioned `pi-memory` extension");
		expect(readme).toContain("The cross-harness capture evaluator measures Claude, Codex, Cursor, and Qoder");
		expect(readme).toContain("mechanism-coverage contract");
	});

	test("separates raw transcript ingestion from host capture support", () => {
		expect(readme).toContain("across Claude Code, Codex, and Pi session history");
		expect(readme).toContain(
			"Cursor and Qoder can use AgentMemory's capture/context hooks, but their raw transcript history is not currently ingested by Pro.",
		);
	});

	test("does not claim the Node-hosted CLI can load the Bun-native Pro runtime", () => {
		expect(readme).toContain("Portable Core CLI (Node.js 20+)");
		expect(readme).toContain("The current Pro bundle is intentionally Bun-native");
		expect(readme).toContain("Node-runtime compatibility is not currently claimed for Pro");
		expect(readme).not.toContain("Pro session recall requires Node.js 22.13+");
		expect(onboarding).toContain("Core is portable under Node.js 20+ on macOS, Linux, and Windows");
		expect(onboarding).toContain("the current Pro bundle is Bun-native");
		expect(onboarding).toContain("npm (cross-platform Core; Node.js 20+)");
		expect(onboarding).toContain("Bun build from source (macOS / Linux / Windows; supported Pro runtime)");
		expect(onboarding).toContain("plugin_runtime_unsupported");
		expect(onboarding).not.toContain("npm-hosted Pro session index requires Node.js 22.13+");
		expect(onboarding).not.toContain("Pro needs Node.js 22.13+");
	});

	test("does not regress to the pre-Codex/Qoder/Cursor capture description", () => {
		expect(readme).not.toContain(
			"Codex, Cursor, and Agent receive checkpoint guidance through their skills; they do not gain a Claude Stop hook.",
		);
		expect(readme).not.toContain("Claude Code also receives a periodic memory-write reminder.");
	});
});
