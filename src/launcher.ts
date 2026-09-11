#!/usr/bin/env node

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExternalCommandHost, runExternalCommand, shouldTryExternalCommand } from "./external-command.js";

async function runCoreCli(): Promise<void> {
	// The npm package keeps dist/cli.js as the public bin for compatibility. During
	// packaging the launcher is copied to that path and the original CLI moves to
	// dist/core-cli.js. The standalone Bun build runs directly from launcher.ts.
	const runningAsPortableBin = path.basename(fileURLToPath(import.meta.url)) === "cli.js";
	if (runningAsPortableBin) await import("./core-cli.js");
	else await import("./cli.js");
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (!shouldTryExternalCommand(command)) {
		await runCoreCli();
		return;
	}

	const host = resolveExternalCommandHost();
	if (!host) {
		await runCoreCli();
		return;
	}

	process.exitCode = runExternalCommand(host, process.argv.slice(2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
