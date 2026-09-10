import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PluginNextActionV1 } from "./plugin-bootstrap.js";
import { type PluginEntitlementStatusV1, validatePluginEntitlementStatusV1 } from "./plugin-host.js";

const DEVICE_FILE = "credentials/device.json";
const DEVICE_CREDENTIAL = /^am_device_[a-f0-9]{64}$/;
const APPROVAL_CODE = /^[a-f0-9]{32}$/;
const INSTALLATION_ID = /^am_install_[A-Za-z0-9_-]{32}$/;
const RESPONSE_MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

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

function validateOnlineEntitlement(value: unknown, expectedInstallationId: string): PluginEntitlementStatusV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DevicePairingFailure("entitlement_response_invalid", "The online entitlement response is invalid");
	const result = value as { schemaVersion?: unknown; installationId?: unknown; entitlement?: unknown };
	if (result.schemaVersion !== 1 || result.installationId !== expectedInstallationId)
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
	return structuredClone(entitlement);
}

export class DevicePairingClient {
	private readonly root: string;
	private readonly coreVersion: string;
	private readonly apiOrigin: string;
	private readonly accountWebOrigin: string;
	private readonly fetchImplementation: typeof globalThis.fetch;
	private readonly now: () => Date;

	constructor(options: DevicePairingClientOptions) {
		this.root = path.resolve(options.root);
		this.coreVersion = options.coreVersion;
		this.apiOrigin = validHttpsOrigin(options.apiOrigin);
		this.accountWebOrigin = validHttpsOrigin(options.accountWebOrigin);
		this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
		this.now = options.now ?? (() => new Date());
	}

	async getManagementAction(): Promise<PluginNextActionV1> {
		let state = this.readState();
		if (state) {
			const status = await this.status(state);
			if (status === null) {
				this.removeState();
				state = null;
			} else if (status.state === "approved") {
				const approved = this.approvedState(state, status.credentialExpiresAt as string);
				this.writeState(approved);
				return {
					kind: "manage",
					url: this.accountWebOrigin,
					message: `This device is linked to your AgentMemory account through ${status.credentialExpiresAt}.`,
				};
			} else if (
				state.approvalCode &&
				APPROVAL_CODE.test(state.approvalCode) &&
				state.approvalExpiresAt &&
				isFuture(state.approvalExpiresAt, this.now())
			) {
				return this.pendingAction(state);
			} else {
				this.removeState();
				state = null;
			}
		}

		if (!state) state = await this.start();
		return this.pendingAction(state);
	}

	async getOnlineEntitlement(): Promise<PluginEntitlementStatusV1 | null> {
		let state = this.readState();
		if (!state) return null;
		if (!state.credentialExpiresAt || !isFuture(state.credentialExpiresAt, this.now())) {
			const status = await this.status(state);
			if (status === null) {
				this.removeState();
				return null;
			}
			if (status.state === "pending") return null;
			state = this.approvedState(state, status.credentialExpiresAt as string);
			this.writeState(state);
		}
		const response = await this.fetch(`${this.apiOrigin}/v1/plugin/entitlement`, {
			method: "POST",
			headers: { Accept: "application/json", Authorization: `Bearer ${state.deviceCredential}` },
		});
		if (response.status === 401) {
			this.removeState();
			return null;
		}
		if (!response.ok)
			throw new DevicePairingFailure(
				"entitlement_service_unavailable",
				`AgentMemory paid access is unavailable (HTTP ${response.status})`,
				response.status >= 500 || response.status === 429,
			);
		return validateOnlineEntitlement(await boundedJson(response), state.installationId);
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
