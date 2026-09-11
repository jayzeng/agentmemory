#!/usr/bin/env node

import { resolveExternalCommandHost, runExternalCommand, shouldTryExternalCommand } from "./external-command.js";

async function runCoreCli(): Promise<void> {
	await import("./cli.js");
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
