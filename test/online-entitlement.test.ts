import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DevicePairingClient } from "../src/device-pairing.js";
import { AgentMemoryServiceBackend } from "../src/plugin-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const installationId = `am_install_${"a".repeat(32)}`;
const deviceCredential = `am_device_${"b".repeat(64)}`;
const credentialExpiresAt = "2026-10-09T20:00:00.000Z";
const signingKeys = generateKeyPairSync("ed25519");
const testPublicKey = signingKeys.publicKey.export({ format: "pem", type: "spki" });
const keyId = "test-entitlement-key";

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
		plan: "pro" as const,
		state: "active" as const,
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
		plan: "free" as const,
		state: "active" as const,
		features: ["session-intelligence", "web-console"],
		capabilities: {
			"session-index": { enabled: true },
			recall: { enabled: true, quota: { limit: 20, window: "day" as const, scope: "device" as const } },
			"session-worker": { enabled: false },
			learning: { enabled: true, quota: { limit: 5, window: "day" as const, scope: "device" as const } },
			"retrieval-evaluation": { enabled: true },
			"operational-metrics": { enabled: true },
			"web-console": { enabled: true },
			"memory-explorer": { enabled: true },
		},
	};
}

function signed(policy: ReturnType<typeof proPolicy> | ReturnType<typeof freePolicy>) {
	const claims = {
		schemaVersion: 1 as const,
		installationId,
		plan: policy.plan,
		features: policy.features,
		capabilities: policy.capabilities,
		channel: "stable" as const,
		issuedAt: "2026-09-09T20:00:00.000Z",
		refreshAfter: "2026-09-10T20:00:00.000Z",
		expiresAt: "2026-10-09T20:00:00.000Z",
		offlineUntil: "2026-09-16T20:00:00.000Z",
	};
	const signature = sign(
		null,
		Buffer.from(`agentmemory-entitlement-v1\n${JSON.stringify(claims)}`),
		signingKeys.privateKey,
	).toString("base64");
	return {
		schemaVersion: 1 as const,
		claims,
		signature: { algorithm: "ed25519" as const, keyId, value: signature },
	};
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function client(stateRoot: string, fetchImplementation: typeof fetch, now: string): DevicePairingClient {
	return new DevicePairingClient({
		root: stateRoot,
		coreVersion: "0.6.0-test",
		apiOrigin: "https://api.example.test",
		accountWebOrigin: "https://account.example.test",
		fetchImplementation,
		now: () => new Date(now),
		entitlementKeys: { [keyId]: testPublicKey },
	});
}

describe("paired signed paid entitlement", () => {
	test("a linked device verifies and persists the signed Pro envelope", async () => {
		const stateRoot = root();
		let calls = 0;
		const pairing = client(
			stateRoot,
			(async (input, init) => {
				calls++;
				expect(String(input)).toBe("https://api.example.test/v1/plugin/entitlement");
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ Authorization: `Bearer ${deviceCredential}` });
				const policy = proPolicy();
				return json({ schemaVersion: 1, installationId, entitlement: policy, signedEntitlement: signed(policy) });
			}) as typeof fetch,
			"2026-09-09T20:01:00.000Z",
		);

		const entitlement = await pairing.getOnlineEntitlement();
		expect(entitlement?.plan).toBe("pro");
		expect(entitlement?.state).toBe("active");
		expect(entitlement?.offlineUntil).toBe("2026-09-16T20:00:00.000Z");
		expect(entitlement?.capabilities["session-worker"]?.enabled).toBe(true);
		expect(entitlement?.capabilities.recall?.quota).toBeUndefined();
		expect(calls).toBe(1);
		expect(fs.readdirSync(path.join(stateRoot, "credentials")).sort()).toEqual(["device.json", "entitlement.json"]);
		if (process.platform !== "win32")
			expect(fs.statSync(path.join(stateRoot, "credentials", "entitlement.json")).mode & 0o077).toBe(0);
	});

	test("online and signed policies compare structurally regardless of property or feature order", async () => {
		const stateRoot = root();
		const signedPolicy = proPolicy();
		const onlinePolicy = {
			...signedPolicy,
			features: [...signedPolicy.features].reverse(),
			capabilities: Object.fromEntries(Object.entries(signedPolicy.capabilities).reverse()),
		};
		const pairing = client(
			stateRoot,
			(async () =>
				json({
					schemaVersion: 1,
					installationId,
					entitlement: onlinePolicy,
					signedEntitlement: signed(signedPolicy),
				})) as typeof fetch,
			"2026-09-09T20:01:00.000Z",
		);
		const entitlement = await pairing.getOnlineEntitlement();
		expect(entitlement?.plan).toBe("pro");
		expect(entitlement?.state).toBe("active");
	});

	test("a network outage uses the last verified Pro envelope during signed grace", async () => {
		const stateRoot = root();
		const online = client(
			stateRoot,
			(async () => {
				const policy = proPolicy();
				return json({ schemaVersion: 1, installationId, entitlement: policy, signedEntitlement: signed(policy) });
			}) as typeof fetch,
			"2026-09-09T20:01:00.000Z",
		);
		expect((await online.getOnlineEntitlement())?.state).toBe("active");

		const offline = client(
			stateRoot,
			(async () => {
				throw new Error("offline");
			}) as typeof fetch,
			"2026-09-12T20:00:00.000Z",
		);
		const entitlement = await offline.getOnlineEntitlement();
		expect(entitlement?.plan).toBe("pro");
		expect(entitlement?.state).toBe("grace");
		expect(entitlement?.capabilities["session-worker"]?.enabled).toBe(true);
	});

	test("a 401 revocation discards both device proof and cached entitlement instead of using offline grace", async () => {
		const stateRoot = root();
		const online = client(
			stateRoot,
			(async () => {
				const policy = proPolicy();
				return json({ schemaVersion: 1, installationId, entitlement: policy, signedEntitlement: signed(policy) });
			}) as typeof fetch,
			"2026-09-09T20:01:00.000Z",
		);
		await online.getOnlineEntitlement();
		const revoked = client(
			stateRoot,
			(async () => json({ schemaVersion: 1, error: { code: "device_credential_invalid" } }, 401)) as typeof fetch,
			"2026-09-12T20:00:00.000Z",
		);
		expect(await revoked.getOnlineEntitlement()).toBeNull();
		expect(fs.existsSync(path.join(stateRoot, "credentials", "device.json"))).toBe(false);
		expect(fs.existsSync(path.join(stateRoot, "credentials", "entitlement.json"))).toBe(false);
	});

	test("server free fallback remains bounded and signed", async () => {
		const stateRoot = root();
		const pairing = client(
			stateRoot,
			(async () => {
				const policy = freePolicy();
				return json({ schemaVersion: 1, installationId, entitlement: policy, signedEntitlement: signed(policy) });
			}) as typeof fetch,
			"2026-09-09T20:01:00.000Z",
		);
		const entitlement = await pairing.getOnlineEntitlement();
		expect(entitlement?.plan).toBe("free");
		expect(entitlement?.capabilities["session-worker"]?.enabled).toBe(false);
		expect(entitlement?.capabilities.recall?.quota?.limit).toBe(20);
		expect(entitlement?.capabilities.learning?.quota?.limit).toBe(5);
	});

	test("tampered or over-permissive signed policy fails closed", async () => {
		const stateRoot = root();
		const policy = proPolicy();
		const envelope = signed(policy);
		envelope.claims.capabilities = {
			...envelope.claims.capabilities,
			recall: { enabled: true, quota: { limit: 999, window: "day", scope: "device" } },
		};
		const pairing = client(
			stateRoot,
			(async () =>
				json({
					schemaVersion: 1,
					installationId,
					entitlement: policy,
					signedEntitlement: envelope,
				})) as typeof fetch,
			"2026-09-09T20:01:00.000Z",
		);
		await expect(pairing.getOnlineEntitlement()).rejects.toThrow("signed AgentMemory entitlement is invalid");
		expect(fs.existsSync(path.join(stateRoot, "credentials", "entitlement.json"))).toBe(false);
	});

	test("account-service outage with no signed cache still falls back to the existing free activation", async () => {
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
