import { afterEach, describe, expect, test } from "bun:test";
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
const approvalCode = "c".repeat(32);
const approvalExpiresAt = "2099-01-01T00:00:00.000Z";
const credentialExpiresAt = "2099-02-01T00:00:00.000Z";

function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-device-pairing-"));
	roots.push(value);
	return value;
}

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function started(): Response {
	return response(
		{
			schemaVersion: 1,
			installationId,
			deviceCredential,
			approvalCode,
			approvalExpiresAt,
			pollIntervalSeconds: 5,
		},
		201,
	);
}

describe("account-device pairing client", () => {
	test("pro manage starts a server-owned pairing without leaking the device credential", async () => {
		const stateRoot = root();
		let startBody: Record<string, unknown> | null = null;
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			coreVersion: "0.6.0-test",
			apiOrigin: "https://api.example.test",
			fetch: (async (input, init) => {
				const url = String(input);
				expect(url).toBe("https://api.example.test/v1/plugin/devices/start");
				startBody = JSON.parse(String(init?.body));
				return started();
			}) as typeof fetch,
		});

		const action = await backend.getManagementAction();
		expect(action).toMatchObject({
			kind: "authenticate",
			url: "https://agentmemory.paperpilot.me",
			userCode: approvalCode,
		});
		expect(startBody).toMatchObject({
			schemaVersion: 2,
			bundleId: "agentmemory.pro",
			installedVersion: null,
			coreVersion: "0.6.0-test",
			channel: "stable",
		});
		expect(startBody).not.toHaveProperty("installationId");
		expect(JSON.stringify(action)).not.toContain(deviceCredential);
		expect(action?.url).not.toContain(approvalCode);

		const statePath = path.join(stateRoot, "credentials", "device.json");
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		expect(state).toMatchObject({ installationId, deviceCredential, approvalCode, approvalExpiresAt });
		if (process.platform !== "win32") expect(fs.statSync(statePath).mode & 0o077).toBe(0);
	});

	test("pending status reuses the original approval code instead of minting another device", async () => {
		const stateRoot = root();
		let starts = 0;
		let statuses = 0;
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			coreVersion: "0.6.0-test",
			apiOrigin: "https://api.example.test",
			fetch: (async (input, init) => {
				const url = String(input);
				if (url.endsWith("/start")) {
					starts++;
					return started();
				}
				statuses++;
				expect(init?.headers).toMatchObject({ Authorization: `Bearer ${deviceCredential}` });
				return response({ schemaVersion: 1, state: "pending", installationId });
			}) as typeof fetch,
		});

		const first = await backend.getManagementAction();
		const second = await backend.getManagementAction();
		expect(first?.userCode).toBe(approvalCode);
		expect(second?.userCode).toBe(approvalCode);
		expect(starts).toBe(1);
		expect(statuses).toBe(1);
	});

	test("approved status removes the approval code while retaining the private device proof", async () => {
		const stateRoot = root();
		let calls = 0;
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			coreVersion: "0.6.0-test",
			apiOrigin: "https://api.example.test",
			fetch: (async (input, init) => {
				calls++;
				if (String(input).endsWith("/start")) return started();
				expect(init?.headers).toMatchObject({ Authorization: `Bearer ${deviceCredential}` });
				return response({
					schemaVersion: 1,
					state: "approved",
					installationId,
					credentialExpiresAt,
				});
			}) as typeof fetch,
		});

		await backend.getManagementAction();
		const action = await backend.getManagementAction();
		expect(action).toMatchObject({ kind: "manage", url: "https://agentmemory.paperpilot.me" });
		expect(action?.userCode).toBeUndefined();
		expect(JSON.stringify(action)).not.toContain(deviceCredential);
		expect(calls).toBe(2);

		const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "credentials", "device.json"), "utf-8"));
		expect(state.deviceCredential).toBe(deviceCredential);
		expect(state.credentialExpiresAt).toBe(credentialExpiresAt);
		expect(state.approvalCode).toBeUndefined();
		expect(state.approvalExpiresAt).toBeUndefined();
	});

	test("an expired or revoked credential is discarded before a fresh pairing starts", async () => {
		const stateRoot = root();
		let starts = 0;
		let statuses = 0;
		const backend = new AgentMemoryServiceBackend({
			root: stateRoot,
			coreVersion: "0.6.0-test",
			apiOrigin: "https://api.example.test",
			fetch: (async (input) => {
				if (String(input).endsWith("/start")) {
					starts++;
					return started();
				}
				statuses++;
				return response({ schemaVersion: 1, error: { code: "device_credential_invalid" } }, 401);
			}) as typeof fetch,
		});

		await backend.getManagementAction();
		const second = await backend.getManagementAction();
		expect(second?.userCode).toBe(approvalCode);
		expect(starts).toBe(2);
		expect(statuses).toBe(1);
	});

	test("an approved credential nearing expiry is rotated without re-pairing", async () => {
		const stateRoot = root();
		const credentials = path.join(stateRoot, "credentials");
		fs.mkdirSync(credentials, { mode: 0o700 });
		fs.writeFileSync(
			path.join(credentials, "device.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				installationId,
				deviceCredential,
				createdAt: "2026-09-01T00:00:00.000Z",
				credentialExpiresAt: "2026-09-11T20:00:00.000Z",
			})}\n`,
			{ mode: 0o600 },
		);
		let rotatedCredential = "";
		const pairing = new DevicePairingClient({
			root: stateRoot,
			coreVersion: "0.6.0-test",
			apiOrigin: "https://api.example.test",
			accountWebOrigin: "https://account.example.test",
			now: () => new Date("2026-09-09T20:00:00.000Z"),
			fetchImplementation: (async (input, init) => {
				const url = String(input);
				expect(init?.headers).toMatchObject({ Authorization: `Bearer ${deviceCredential}` });
				if (url.endsWith("/status"))
					return response({
						schemaVersion: 1,
						state: "approved",
						installationId,
						credentialExpiresAt: "2026-09-11T20:00:00.000Z",
					});
				expect(url).toBe("https://api.example.test/v1/plugin/devices/renew");
				rotatedCredential = JSON.parse(String(init?.body)).nextDeviceCredential;
				return response({
					schemaVersion: 1,
					installationId,
					deviceCredential: rotatedCredential,
					credentialExpiresAt: "2026-10-09T20:00:00.000Z",
				});
			}) as typeof fetch,
		});

		const action = await pairing.getManagementAction();
		expect(action).toMatchObject({ kind: "manage", url: "https://account.example.test" });
		const state = JSON.parse(fs.readFileSync(path.join(credentials, "device.json"), "utf-8"));
		expect(state.deviceCredential).toBe(rotatedCredential);
		expect(state.credentialExpiresAt).toBe("2026-10-09T20:00:00.000Z");
		expect(JSON.stringify(action)).not.toContain(rotatedCredential);
	});
});

test("lost rotation responses survive a client restart and concurrent clients share one renewal", async () => {
	const stateRoot = root();
	const credentials = path.join(stateRoot, "credentials");
	fs.mkdirSync(credentials, { mode: 0o700 });
	const target = path.join(credentials, "device.json");
	fs.writeFileSync(
		target,
		JSON.stringify({
			schemaVersion: 1,
			installationId,
			deviceCredential,
			createdAt: "2026-09-01T00:00:00.000Z",
			credentialExpiresAt: "2026-09-11T20:00:00.000Z",
		}),
		{ mode: 0o600 },
	);
	let attempts = 0;
	let replacement = "";
	const fetchImplementation = (async (input, init) => {
		if (String(input).endsWith("/renew")) {
			const next = JSON.parse(String(init?.body)).nextDeviceCredential;
			expect(JSON.parse(fs.readFileSync(target, "utf8")).pendingDeviceCredential).toBe(next);
			if (++attempts === 1) {
				replacement = next;
				throw new Error("response lost after server commit");
			}
			expect(next).toBe(replacement);
			return response({
				schemaVersion: 1,
				installationId,
				deviceCredential: next,
				credentialExpiresAt: "2026-10-09T20:00:00.000Z",
			});
		}
		return response({
			schemaVersion: 1,
			installationId,
			state: "approved",
			credentialExpiresAt: replacement ? "2026-10-09T20:00:00.000Z" : "2026-09-11T20:00:00.000Z",
		});
	}) as typeof fetch;
	const createClient = () =>
		new DevicePairingClient({
			root: stateRoot,
			coreVersion: "0.6.0-test",
			apiOrigin: "https://api.example.test",
			accountWebOrigin: "https://account.example.test",
			now: () => new Date("2026-09-09T20:00:00.000Z"),
			fetchImplementation,
		});
	await expect(createClient().getManagementAction()).rejects.toThrow();
	const results = await Promise.all([createClient().getManagementAction(), createClient().getManagementAction()]);
	expect(results.map((r) => r.kind)).toEqual(["manage", "manage"]);
	expect(attempts).toBe(2);
	const persisted = JSON.parse(fs.readFileSync(target, "utf8"));
	expect(persisted.deviceCredential).toBe(replacement);
	expect(persisted.pendingDeviceCredential).toBeUndefined();
});

test("an abandoned empty pairing lock is reclaimed instead of blocking future pairing", async () => {
	const stateRoot = root();
	const lockPath = path.join(stateRoot, "device-pairing.lock");
	fs.writeFileSync(lockPath, "", { mode: 0o600 });
	fs.utimesSync(lockPath, new Date(0), new Date(0));
	let starts = 0;
	const pairing = new DevicePairingClient({
		root: stateRoot,
		coreVersion: "0.6.0-test",
		apiOrigin: "https://api.example.test",
		accountWebOrigin: "https://account.example.test",
		fetchImplementation: (async (input) => {
			expect(String(input)).toBe("https://api.example.test/v1/plugin/devices/start");
			starts++;
			return started();
		}) as typeof fetch,
	});
	const action = await pairing.getManagementAction();
	expect(action.kind).toBe("authenticate");
	expect(starts).toBe(1);
	expect(fs.existsSync(lockPath)).toBe(false);
});
