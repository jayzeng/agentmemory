import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { resolveExternalCommandHost, shouldTryExternalCommand } from "../src/external-command.js";

describe("external command handoff", () => {
	test("keeps core commands in the public CLI", () => {
		for (const command of [
			"help",
			"version",
			"install-skills",
			"uninstall-skills",
			"context",
			"write",
			"read",
			"scratchpad",
			"search",
			"distil",
			"distill",
			"sync",
			"init",
			"status",
		]) {
			expect(shouldTryExternalCommand(command)).toBe(false);
		}
		expect(shouldTryExternalCommand(undefined)).toBe(false);
		expect(shouldTryExternalCommand("--help")).toBe(false);
	});

	test("accepts only safe non-core command names", () => {
		expect(shouldTryExternalCommand("recall")).toBe(true);
		expect(shouldTryExternalCommand("session-recall")).toBe(true);
		expect(shouldTryExternalCommand("../recall")).toBe(false);
		expect(shouldTryExternalCommand("Recall")).toBe(false);
		expect(shouldTryExternalCommand("recall/foo")).toBe(false);
	});

	test("resolves one fixed user-local host path", () => {
		const homeDir = path.join(path.sep, "tmp", "home");
		const expected = path.join(homeDir, ".agent-memory", "bin", "agent-memory-extension");
		expect(
			resolveExternalCommandHost({
				homeDir,
				platform: "linux",
				isFile: (target) => target === expected,
			}),
		).toBe(expected);
		expect(resolveExternalCommandHost({ homeDir, platform: "linux", isFile: () => false })).toBeNull();
	});

	test("uses an executable suffix on Windows", () => {
		const homeDir = "C:\\Users\\test";
		const expected = path.join(homeDir, ".agent-memory", "bin", "agent-memory-extension.exe");
		expect(
			resolveExternalCommandHost({
				homeDir,
				platform: "win32",
				isFile: (target) => target === expected,
			}),
		).toBe(expected);
	});
});
