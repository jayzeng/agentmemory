import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * AgentMemory extension for Pi Coding Agent.
 *
 * Subscribes to session_start and runs `agent-memory context` to inject
 * persistent memory at the start of every session.
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			const result = await pi.exec("agent-memory", ["context"], {
				timeout: 10000,
			});
			if (result.stdout?.trim()) {
				ctx.ui.notify(`Memory loaded: ${result.stdout.split("\n").length} lines`, "info");
			}
		} catch {
			// agent-memory not installed or not on PATH — skip silently
		}
	});
}
