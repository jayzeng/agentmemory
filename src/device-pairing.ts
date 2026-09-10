import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PluginNextActionV1 } from "./plugin-bootstrap.js";
import { type PluginEntitlementStatusV1, validatePluginEntitlementStatusV1 } from "./plugin-host.js";
import { type EntitlementVerificationKeys, SignedEntitlementCache } from "./signed-entitlement.js";

const DEVICE_FILE = "credentials/device.json";
const DEVICE_CREDENTIAL = /^am_device_[a-f0-9]{64}$/;
const APPROVAL_CODE = /^[a-f0-9]{32}$/;
const INSTALLATION_ID = /^am_install_[A-Za-z0-9_-]{32}$/;
const RESPONSE_MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
const RENEW_BEFORE_MS = 3 * DAY_MS;

interface DevicePairingStateV1 {
	schemaVersion: 1;
	installationId: string;
	deviceCredential: string;
	createdAt: string;
	approvalCode?: string;
	approvalExpiresAt?: string;
	credentialExpiresAt?: string;
}

interface DevicePairingClientOptions {
	root: string;
	coreVersion: string;
	apiOrigin: string;
	accountWebOrigin: string;
	fetchImplementation?: typeof globalThis.fetch;
	now?: () => Date;
	entitlementKeys?: EntitlementVerificationKeys;
}

interface StartResponseV1 {
	schemaVersion: 1;
	installationId: string;
	deviceCredential: string;
	approvalCode: string;
	approvalExpiresAt: string;
	pollIntervalSeconds: number;
}

interface StatusResponseV1 {
	schemaVersion: 1;
	state: "pending" | "approved";
	installationId: string;
	credentialExpiresAt?: string;
}

interface RenewResponseV1 {
	schemaVersion: 1;
	installationId: string;
	deviceCredential: string;
	credentialExpiresAt: string;
}

export class DevicePairingFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "DevicePairingFailure";
	}
}

function validHttpsOrigin(value: string): string {
	const parsed = new URL(value);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	)
		throw new DevicePairingFailure("pairing_configuration_invalid", "The AgentMemory account origin is invalid");
	return parsed.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES)
		throw new DevicePairingFailure("pairing_response_invalid", "The device-pairing response is too large");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > RESPONSE_MAX_BYTES)
		throw new DevicePairingFailure("pairing_response_invalid", "The device-pairing response is too large");
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new DevicePairingFailure("pairing_response_invalid", "The device-pairing response is invalid");
	}
}

function isFuture(value: string, now: Date): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function validateStart(value: unknown, now: Date): StartResponseV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DevicePairingFailure("pairing_response_invalid", "The device-pairing response is invalid");
	const result = value as Partial<StartResponseV1>;
	if (
		result.schemaVersion !== 1 ||
		typeof result.installationId !== "string" ||
		!INSTALLATION_ID.test(result.installationId) ||
		typeof result.deviceCredential !== "string" ||
		!DEVICE_CREDENTIAL.test(result.deviceCredential) ||
		typeof result.approvalCode !== "string" ||
		!APPROVAL_CODE.test(result.approvalCode) ||
		typeof result.approvalExpiresAt !== "string" ||
		!isFuture(result.approvalExpiresAt, now) ||
		!Number.isSafeInteger(result.pollIntervalSeconds) ||
		(result.pollIntervalSeconds ?? 0) < 1 ||
		(result.pollIntervalSeconds ?? 0) > 60
	)
		throw new DevicePairingFailure("pairing_response_invalid", "The device-pairing response is invalid");
	return result as StartResponseV1;
}

function validateStatus(value: unknown, expectedInstallationId: string, now: Date): StatusResponseV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DevicePairingFailure("pairing_response_invalid", "The device-pairing status is invalid");
	const result = value as Partial<StatusResponseV1>;
	if (
		result.schemaVersion !== 1 ||
		(result.state !== "pending" && result.state !== "approved") ||
		result.installationId !== expectedInstallationId
	)
		throw new DevicePairingFailure("pairing_response_invalid", "The device-pairing status is invalid");
	if (
		result.state === "approved" &&
		(typeof result.credentialExpiresAt !== "string" || !isFuture(result.credentialExpiresAt, now))
	)
		throw new DevicePairingFailure("pairing_response_invalid", "The approved device credential is invalid");
	return result as StatusResponseV1;
}

function validateRenew(value: unknown, expectedInstallationId: string, now: Date): RenewResponseV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DevicePairingFailure("pairing_response_invalid", "The device renewal response is invalid");
	const result = value as Partial<RenewResponseV1>;
	if (
		result.schemaVersion !== 1 ||
		result.installationId !== expectedInstallationId ||
		typeof result.deviceCredential !== "string" ||
		!DEVICE_CREDENTIAL.test(result.deviceCredential) ||
		typeof result.credentialExpiresAt !== "string" ||
		!isFuture(result.credentialExpiresAt, now)
	)
		throw new DevicePairingFailure("pairing_response_invalid", "The device renewal response is invalid");
	return result as RenewResponseV1;
}

function validateOnlineEntitlement(
	value: unknown,
	expectedInstallationId: string,
): { entitlement: PluginEntitlementStatusV1; signedEntitlement: unknown } {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DevicePairingFailure("entitlement_response_invalid", "The online entitlement response is invalid");
	const result = value as {
		schemaVersion?: unknown;
		installationId?: unknown;
		entitlement?: unknown;
		signedEntitlement?: unknown;
	};
	if (result.schemaVersion !== 1 || result.installationId !== expectedInstallationId || !result.signedEntitlement)
		throw new DevicePairingFailure("entitlement_response_invalid", "The online entitlement response is invalid");
	try {
		validatePluginEntitlementStatusV1(result.entitlement);
	} catch {
		throw new DevicePairingFailure("entitlement_response_invalid", "The online entitlement policy is invalid");
	}
	const entitlement = result.entitlement;
	if (
		entitlement.state !== "active" ||
		(entitlement.plan !== "pro" && entitlement.plan !== "free") ||
		entitlement.capabilities["session-index"]?.enabled !== true ||
		entitlement.capabilities.recall?.enabled !== true ||
		entitlement.capabilities.learning?.enabled !== true ||
		entitlement.capabilities["web-console"]?.enabled !== true ||
		entitlement.capabilities["memory-explorer"]?.enabled !== true
	)
		throw new DevicePairingFailure("entitlement_response_invalid", "The online entitlement policy is invalid");
	if (entitlement.plan === "pro") {
		if (
			entitlement.capabilities["session-worker"]?.enabled !== true ||
			entitlement.capabilities.recall.quota !== undefined ||
			entitlement.capabilities.learning.quota !== undefined
		)
			throw new DevicePairingFailure("entitlement_response_invalid", "The Pro entitlement policy is invalid");
	} else {
		const recall = entitlement.capabilities.recall.quota;
		const learning = entitlement.capabilities.learning.quota;
		if (
			entitlement.capabilities["session-worker"]?.enabled !== false ||
			recall?.limit !== 20 ||
			recall.window !== "day" ||
			recall.scope !== "device" ||
			learning?.limit !== 5 ||
			learning.window !== "day" ||
			learning.scope !== "device"
		)
			throw new DevicePairingFailure("entitlement_response_invalid", "The free entitlement policy is invalid");
	}
	return { entitlement: structuredClone(entitlement), signedEntitlement: result.signedEntitlement };
}

function policiesMatch(a: PluginEntitlementStatusV1, b: PluginEntitlementStatusV1): boolean {
	return (
		a.plan === b.plan &&
		JSON.stringify(a.features) === JSON.stringify(b.features) &&
		JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities)
	);
}

export class DevicePairingClient {
	private readonly root: string;
	private readonly coreVersion: string;
	private readonly apiOrigin: string;
	private readonly accountWebOrigin: string;
	private readonly fetchImplementation: typeof globalThis.fetch;
	private readonly now: () => Date;
	private readonly entitlementCache: SignedEntitlementCache;

	constructor(options: DevicePairingClientOptions) {
		this.root = path.resolve(options.root);
		this.coreVersion = options.coreVersion;
		this.apiOrigin = validHttpsOrigin(options.apiOrigin);
		this.accountWebOrigin = validHttpsOrigin(options.accountWebOrigin);
		this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
		this.now = options.now ?? (() => new Date());
		this.entitlementCache = new SignedEntitlementCache(this.root, options.entitlementKeys);
	}

	async getManagementAction(): Promise<PluginNextActionV1> {
		let state = this.readState();
		if (state) {
			if (state.credentialExpiresAt) {
				const expiry = Date.parse(state.credentialExpiresAt);
				if (Number.isFinite(expiry) && expiry <= this.now().getTime()) {
					const renewed = await this.renew(state);
					if (renewed) {
						return {
							kind: "manage",
							url: this.accountWebOrigin,
							message: `This device is linked to your AgentMemory account through ${renewed.credentialExpiresAt}.`,
						};
					}
					this.removeStateAndCache();
					state = null;
				}
			}
			if (state) {
				const status = await this.status(state);
				if (status === null) {
					this.removeStateAndCache();
					state = null;
				} else if (status.state === "approved") {
					let approved = this.approvedState(state, status.credentialExpiresAt as string);
					if (Date.parse(status.credentialExpiresAt as string) - this.now().getTime() <= RENEW_BEFORE_MS)
						approved = (await this.renew(approved)) ?? approved;
					this.writeState(approved);
					return {
						kind: "manage",
						url: this.accountWebOrigin,
						message: `This device is linked to your AgentMemory account through ${approved.credentialExpiresAt}.`,
					};
				} else if (
					state.approvalCode &&
					APPROVAL_CODE.test(state.approvalCode) &&
					state.approvalExpiresAt &&
					isFuture(state.approvalExpiresAt, this.now())
				) {
					return this.pendingAction(state);
				} else {
					this.removeStateAndCache();
					state = null;
				}
			}
		}

		if (!state) state = await this.start();
		return this.pendingAction(state);
	}

	async getOnlineEntitlement(): Promise<PluginEntitlementStatusV1 | null> {
		let state = this.readState();
		if (!state) return null;
		const pairingInstallationId = state.installationId;
		try {
			state = await this.ensureCredential(state);
			if (!state) return null;
			const response = await this.fetch(`${this.apiOrigin}/v1/plugin/entitlement`, {
				method: "POST",
				headers: { Accept: "application/json", Authorization: `Bearer ${state.deviceCredential}` },
			});
			if (response.status === 401) {
				this.removeStateAndCache();
				return null;
			}
			if (!response.ok)
				throw new DevicePairingFailure(
					"entitlement_service_unavailable",
					`AgentMemory paid access is unavailable (HTTP ${response.status})`,
					response.status >= 500 || response.status === 429,
				);
			const online = validateOnlineEntitlement(await boundedJson(response), state.installationId);
			let verified: PluginEntitlementStatusV1;
			try {
				verified = this.entitlementCache.write(online.signedEntitlement, state.installationId, this.now());
			} catch {
				throw new DevicePairingFailure("entitlement_signature_invalid", "The signed AgentMemory entitlement is invalid");
			}
			if (verified.state !== "active" || !policiesMatch(online.entitlement, verified)) {
				this.entitlementCache.remove();
				throw new DevicePairingFailure("entitlement_response_invalid", "The signed and online entitlement policies disagree");
			}
			return verified;
		} catch (error) {
			if (error instanceof DevicePairingFailure && error.retryable) {
				const cached = this.entitlementCache.read(pairingInstallationId, this.now());
				if (cached && (cached.state === "active" || cached.state === "grace")) return cached;
			}
			throw error;
		}
	}

	private async ensureCredential(state: DevicePairingStateV1): Promise<DevicePairingStateV1 | null> {
		if (!state.credentialExpiresAt) {
			const status = await this.status(state);
			if (status === null) {
				this.removeStateAndCache();
				return null;
			}
			if (status.state === "pending") return null;
			state = this.approvedState(state, status.credentialExpiresAt as string);
			this.writeState(state);
		}
		const expiresAt = Date.parse(state.credentialExpiresAt as string);
		if (!Number.isFinite(expiresAt)) {
			this.removeStateAndCache();
			return null;
		}
		if (expiresAt - this.now().getTime() <= RENEW_BEFORE_MS) {
			const renewed = await this.renew(state);
			if (!renewed) {
				this.removeStateAndCache();
				return null;
			}
			return renewed;
		}
		return state;
	}

	private approvedState(state: DevicePairingStateV1, credentialExpiresAt: string): DevicePairingStateV1 {
		return {
			schemaVersion: 1,
			installationId: state.installationId,
			deviceCredential: state.deviceCredential,
			createdAt: state.createdAt,
			credentialExpiresAt,
		};
	}

	private pendingAction(state: DevicePairingStateV1): PluginNextActionV1 {
		if (!state.approvalCode || !state.approvalExpiresAt)
			throw new DevicePairingFailure("pairing_state_invalid", "The local device-pairing state is incomplete");
		return {
			kind: "authenticate",
			url: this.accountWebOrigin,
			userCode: state.approvalCode,
			message: `Sign in to AgentMemory and approve this device code before ${state.approvalExpiresAt}.`,
		};
	}

	private async start(): Promise<DevicePairingStateV1> {
		const response = await this.fetch(`${this.apiOrigin}/v1/plugin/devices/start`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 2,
				bundleId: "agentmemory.pro",
				installedVersion: null,
				coreVersion: this.coreVersion,
				channel: "stable",
				platform: process.platform,
				architecture: process.arch,
			}),
		});
		if (response.status !== 201)
			throw new DevicePairingFailure(
				"pairing_start_failed",
				`AgentMemory device pairing could not start (HTTP ${response.status})`,
				response.status >= 500 || response.status === 429,
			);
		const started = validateStart(await boundedJson(response), this.now());
		const state: DevicePairingStateV1 = {
			schemaVersion: 1,
			installationId: started.installationId,
			deviceCredential: started.deviceCredential,
			approvalCode: started.approvalCode,
			approvalExpiresAt: started.approvalExpiresAt,
			createdAt: this.now().toISOString(),
		};
		this.writeState(state);
		return state;
	}

	private async status(state: DevicePairingStateV1): Promise<StatusResponseV1 | null> {
		const response = await this.fetch(`${this.apiOrigin}/v1/plugin/devices/status`, {
			method: "POST",
			headers: { Accept: "application/json", Authorization: `Bearer ${state.deviceCredential}` },
		});
		if (response.status === 401) return null;
		if (!response.ok)
			throw new DevicePairingFailure(
				"pairing_status_failed",
				`AgentMemory device pairing status is unavailable (HTTP ${response.status})`,
				response.status >= 500 || response.status === 429,
			);
		return validateStatus(await boundedJson(response), state.installationId, this.now());
	}

	private async renew(state: DevicePairingStateV1): Promise<DevicePairingStateV1 | null> {
		const response = await this.fetch(`${this.apiOrigin}/v1/plugin/devices/renew`, {
			method: "POST",
			headers: { Accept: "application/json", Authorization: `Bearer ${state.deviceCredential}` },
		});
		if (response.status === 401) return null;
		if (!response.ok)
			throw new DevicePairingFailure(
				"pairing_renewal_failed",
				`AgentMemory device credential renewal is unavailable (HTTP ${response.status})`,
				response.status >= 500 || response.status === 429,
			);
		const renewed = validateRenew(await boundedJson(response), state.installationId, this.now());
		const next: DevicePairingStateV1 = {
			schemaVersion: 1,
			installationId: state.installationId,
			deviceCredential: renewed.deviceCredential,
			createdAt: state.createdAt,
			credentialExpiresAt: renewed.credentialExpiresAt,
		};
		this.writeState(next);
		return next;
	}

	private async fetch(url: string, init: RequestInit): Promise<Response> {
		try {
			return await this.fetchImplementation(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		} catch {
			throw new DevicePairingFailure(
				"pairing_service_unavailable",
				"The AgentMemory account service is unavailable",
				true,
			);
		}
	}

	private statePath(): string {
		return path.join(this.root, ...DEVICE_FILE.split("/"));
	}

	private readState(): DevicePairingStateV1 | null {
		const target = this.statePath();
		if (!fs.existsSync(target)) return null;
		try {
			const root = fs.lstatSync(this.root);
			const directory = fs.lstatSync(path.dirname(target));
			const stat = fs.lstatSync(target);
			if (
				!root.isDirectory() ||
				root.isSymbolicLink() ||
				!directory.isDirectory() ||
				directory.isSymbolicLink() ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
			)
				return null;
			const value = JSON.parse(fs.readFileSync(target, "utf-8")) as Partial<DevicePairingStateV1>;
			if (
				value.schemaVersion !== 1 ||
				typeof value.installationId !== "string" ||
				!INSTALLATION_ID.test(value.installationId) ||
				typeof value.deviceCredential !== "string" ||
				!DEVICE_CREDENTIAL.test(value.deviceCredential) ||
				typeof value.createdAt !== "string" ||
				!Number.isFinite(Date.parse(value.createdAt)) ||
				(value.approvalCode !== undefined && !APPROVAL_CODE.test(value.approvalCode)) ||
				(value.approvalExpiresAt !== undefined && !Number.isFinite(Date.parse(value.approvalExpiresAt))) ||
				(value.credentialExpiresAt !== undefined && !Number.isFinite(Date.parse(value.credentialExpiresAt)))
			)
				return null;
			return value as DevicePairingStateV1;
		} catch {
			return null;
		}
	}

	private writeState(value: DevicePairingStateV1): void {
		fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const root = fs.lstatSync(this.root);
		if (!root.isDirectory() || root.isSymbolicLink())
			throw new DevicePairingFailure("pairing_path_invalid", "The plugin state root is unsafe");
		const target = this.statePath();
		const directoryPath = path.dirname(target);
		if (!fs.existsSync(directoryPath)) fs.mkdirSync(directoryPath, { mode: 0o700 });
		const directory = fs.lstatSync(directoryPath);
		if (!directory.isDirectory() || directory.isSymbolicLink())
			throw new DevicePairingFailure("pairing_path_invalid", "The plugin credential directory is unsafe");
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
		try {
			fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			fs.renameSync(temporary, target);
		} finally {
			try {
				if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
			} catch {
				// The original write/rename failure is more useful than cleanup noise.
			}
		}
	}

	private removeStateAndCache(): void {
		this.removeState();
		this.entitlementCache.remove();
	}

	private removeState(): void {
		const target = this.statePath();
		try {
			if (!fs.existsSync(target)) return;
			const stat = fs.lstatSync(target);
			if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(target);
		} catch {
			// A stale pairing can be replaced on the next successful write; do not expose credential paths.
		}
	}
}
