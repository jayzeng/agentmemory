import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentMemoryServiceBackend } from "../src/plugin-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const installationId = `am_install_${"a".repeat(32)}`;
const deviceCredential = `am_device_${"b".repeat(64)}`;
const credentialExpiresAt = "2099-01-01T00:00:00.000Z";

function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-online-entitlement-"));
	roots.push(value);
	const credentials = path.join(value, "credentials");
	fs.mkdirSync(credentials, { mode: 0o700 });
	fs.writeFileSync(
		path.join(credentials, "device.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			installationId,
			deviceCredential,
			createdAt: "2026-09-09T00:00:00.000Z",
			credentialExpiresAt,
		})}\n`,
		{ mode: 0o600 },
	);
	return value;
}

function proPolicy() {
	return {
		plan: "pro",
		state: "active",
		features: ["session-intelligence", "web-console"],
		capabilities: {
			"session-index": { enabled: true },
			recall: { enabled: true },
			"session-worker": { enabled: true },
			learning: { enabled: true },
			"retrieval-evaluation": { enabled: true },
			"operational-metrics": { enabled: true },
			"web-console": { enabled: true },
			"memory-explorer": { enabled: true },
		},
	};
}

function freePolicy() {
	return {
		plan: "free",
		state: "active",
		features: ["session-intelligence", "web-console"],
		capabilities: {
			"session-index": { enabled: true },
			recall: { enabled: true, quota: { limit: 20, window: "day", scope: "device" } },
			"session-worker": { enabled: false },
			learning: { enabled: true, quota: { limit: 5, window: "day", scope: "device" } },
			"retrieval-evaluation": { enabled: true },
			"operational-metrics": { enabled: true },
			"web-console": { enabled: true },
			"memory-explorer": { enabled: true },
		},
	};
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("paired online paid entitlement", () => {
	test("a linked device can enable Pro from the authenticated online projection without persisting it", async () => {
		const stateRoot = root();
		let calls = 0;
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			coreVersion: "0.6.0-test",
			apiOrigin: "https://api.example.test",
			fetch: (async (input, init) => {
				calls++;
				expect(String(input)).toBe("https://api.example.test/v1/plugin/entitlement");
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ Authorization: `Bearer ${deviceCredential}` });
				return json({ schemaVersion: 1, installationId, entitlement: proPolicy() });
			}) as typeof fetch,
		});

		const entitlement = await backend.getLocalEntitlement();
		expect(entitlement.plan).toBe("pro");
		expect(entitlement.capabilities["session-worker"]?.enabled).toBe(true);
		expect(entitlement.capabilities.recall?.quota).toBeUndefined();
		expect(calls).toBe(1);
		expect(fs.readdirSync(path.join(stateRoot, "credentials")).sort()).toEqual(["device.json"]);
	});

	test("server free fallback remains bounded and cannot silently enable paid worker access", async () => {
		const stateRoot = root();
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			apiOrigin: "https://api.example.test",
			fetch: (async () => json({ schemaVersion: 1, installationId, entitlement: freePolicy() })) as typeof fetch,
		});
		const entitlement = await backend.getLocalEntitlement();
		expect(entitlement.plan).toBe("free");
		expect(entitlement.capabilities["session-worker"]?.enabled).toBe(false);
		expect(entitlement.capabilities.recall?.quota?.limit).toBe(20);
		expect(entitlement.capabilities.learning?.quota?.limit).toBe(5);
	});

	test("malformed or over-permissive online policy fails safe instead of granting Pro", async () => {
		const stateRoot = root();
		const activationPath = path.join(stateRoot, "credentials", "activation.json");
		fs.writeFileSync(
			activationPath,
			`${JSON.stringify({ schemaVersion: 4, installationId, activatedAt: "2026-09-09T00:00:00.000Z" })}\n`,
			{ mode: 0o600 },
		);
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			apiOrigin: "https://api.example.test",
			fetch: (async () =>
				json({
					schemaVersion: 1,
					installationId,
					entitlement: {
						...proPolicy(),
						capabilities: { ...proPolicy().capabilities, recall: { enabled: true, quota: { limit: 999 } } },
					},
				})) as typeof fetch,
		});
		const entitlement = await backend.getLocalEntitlement();
		expect(entitlement.plan).toBe("free");
		expect(entitlement.capabilities["session-worker"]?.enabled).toBe(false);
	});

	test("account-service outage falls back to the existing free activation and never blocks Core", async () => {
		const stateRoot = root();
		fs.writeFileSync(
			path.join(stateRoot, "credentials", "activation.json"),
			`${JSON.stringify({ schemaVersion: 4, installationId, activatedAt: "2026-09-09T00:00:00.000Z" })}\n`,
			{ mode: 0o600 },
		);
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			apiOrigin: "https://api.example.test",
			fetch: (async () => {
				throw new Error("offline");
			}) as typeof fetch,
		});
		const entitlement = await backend.getLocalEntitlement();
		expect(entitlement.plan).toBe("free");
		expect(entitlement.state).toBe("active");
	});
});
