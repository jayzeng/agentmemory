import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";

import {
	getDefaultPluginInstallRoot,
	type PluginAccessDecisionV1,
	type PluginBootstrapBackendV1,
	PluginBootstrapFailure,
	type PluginNextActionV1,
	type PluginSessionUsageDecisionV1,
	type SignedPluginReleaseV1,
} from "./plugin-bootstrap.js";
import { type PluginEntitlementStatusV1, validatePluginEntitlementStatusV1 } from "./plugin-host.js";

const API_ORIGIN = "https://api.agentmemory.paperpilot.me";
const ARTIFACT_ORIGIN = "https://plugins.agentmemory.paperpilot.me";
const ACTIVATION_FILE = "credentials/temporary-access.json";
const REQUEST_TIMEOUT_MS = 30_000;
const EMAIL_MAX_BYTES = 254;
const FORM_MAX_BYTES = 2_048;
const SERVICE_JSON_MAX_BYTES = 1024 * 1024;
const ACTIVATION_CREDENTIAL = /^am_activation_[A-Za-z0-9_-]{32,256}$/;

const MISSING_ENTITLEMENT: PluginEntitlementStatusV1 = {
	plan: null,
	state: "missing",
	features: [],
	capabilities: {},
	reason: "Enter an email address to activate the free daily session allowance",
};

interface TemporaryActivationV1 {
	schemaVersion: 2;
	email: string;
	activatedAt: string;
	usageCredential: string;
	dailySessionLimit: number;
}

interface TemporaryPluginBackendOptions {
	root?: string;
	coreVersion?: string;
	apiOrigin?: string;
	artifactOrigin?: string;
	fetch?: typeof globalThis.fetch;
	openUrl?: (url: string) => boolean;
	activate?: () => Promise<string>;
}

function cloneEntitlement(value: PluginEntitlementStatusV1): PluginEntitlementStatusV1 {
	return structuredClone(value);
}

function freeEntitlement(dailySessionLimit: number): PluginEntitlementStatusV1 {
	return {
		plan: "free",
		state: "active",
		features: ["session-intelligence", "web-console"],
		capabilities: {
			"session-index": { enabled: true },
			"session-worker": {
				enabled: true,
				quota: { limit: dailySessionLimit, window: "day", scope: "account" },
			},
			learning: { enabled: true },
			"retrieval-evaluation": { enabled: true },
			"operational-metrics": { enabled: true },
			"web-console": { enabled: true },
			"memory-explorer": { enabled: true },
		},
		reason: `${dailySessionLimit} free agent sessions per UTC day`,
	};
}

function isEmail(value: string): boolean {
	return (
		Buffer.byteLength(value, "utf-8") <= EMAIL_MAX_BYTES &&
		[...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
	);
}

function securityHeaders(contentType: string): Record<string, string> {
	return {
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		"Content-Type": contentType,
		"Referrer-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
	};
}

function activationPage(action: string, error?: string): string {
	const errorHtml = error ? `<p class="error">${error}</p>` : "";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Activate AgentMemory</title><style>body{font:16px system-ui;max-width:34rem;margin:10vh auto;padding:0 1.5rem;color:#18212b}form{display:grid;gap:1rem}input,button{font:inherit;padding:.8rem;border-radius:.5rem;border:1px solid #aab4bf}button{background:#18212b;color:#fff;cursor:pointer}.muted{color:#586574}.error{color:#a21d24}</style></head><body><h1>Activate AgentMemory</h1><p>Enter an email address to enable the free daily agent-session allowance on this device.</p>${errorHtml}<form method="post" action="${action}"><label>Email <input type="email" name="email" autocomplete="email" maxlength="254" required autofocus></label><button type="submit">Activate and return to terminal</button></form><p class="muted">The AgentMemory CLI sends your email plus core, bundle, platform, architecture, and release-channel metadata to the private activation service. D1 stores a daily count of opaque SessionStart operations for your normalized email. The request never includes memory, session content, queries, repository paths, raw agent session identifiers, IP addresses, or user-agent strings. Activation records expire after 365 days without use.</p></body></html>`;
}

function completionPage(): string {
	return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AgentMemory activated</title></head><body><h1>Activation complete</h1><p>You can close this tab and return to the terminal.</p></body></html>';
}

function send(response: ServerResponse, status: number, body: string, contentType = "text/html; charset=utf-8"): void {
	response.writeHead(status, securityHeaders(contentType));
	response.end(body);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new PluginBootstrapFailure("service_response_too_large", "The plugin service response is too large");
		}
		chunks.push(value);
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(await readBoundedBody(response, SERVICE_JSON_MAX_BYTES)));
	} catch (error) {
		if (error instanceof PluginBootstrapFailure) throw error;
		throw new PluginBootstrapFailure("service_response_invalid", "The plugin service returned invalid JSON");
	}
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > FORM_MAX_BYTES) {
				reject(new Error("form too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf-8"))));
		request.on("error", reject);
	});
}

function isSameOriginActivationPost(request: IncomingMessage, expectedHost: string, activationPath: string): boolean {
	const expectedOrigin = `http://${expectedHost}`;
	const origin = request.headers.origin;
	const fetchSite = request.headers["sec-fetch-site"];
	if (origin === "null") {
		return (
			fetchSite === "same-origin" &&
			request.headers["sec-fetch-mode"] === "navigate" &&
			request.headers["sec-fetch-dest"] === "document" &&
			request.headers["sec-fetch-user"] === "?1"
		);
	}
	if (origin !== undefined) return origin === expectedOrigin;

	if (fetchSite !== undefined && fetchSite !== "same-origin") return false;

	const referer = request.headers.referer;
	if (referer !== undefined) {
		try {
			const parsed = new URL(referer);
			return parsed.origin === expectedOrigin && parsed.pathname === activationPath;
		} catch {
			return false;
		}
	}

	// Privacy-focused and older browsers may omit all three headers. The exact
	// loopback Host plus the 192-bit, single-use path remains the CSRF capability.
	return true;
}

export function openLoopbackUrl(url: string): boolean {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return false;
	try {
		const child =
			process.platform === "darwin"
				? spawn("open", [parsed.toString()], { detached: true, stdio: "ignore" })
				: process.platform === "win32"
					? spawn("explorer.exe", [parsed.toString()], { detached: true, stdio: "ignore" })
					: spawn("xdg-open", [parsed.toString()], { detached: true, stdio: "ignore" });
		child.unref();
		return true;
	} catch {
		return false;
	}
}

export async function collectTemporaryActivation(openUrl: (url: string) => boolean = openLoopbackUrl): Promise<string> {
	const nonce = randomBytes(24).toString("hex");
	const activationPath = `/activate/${nonce}`;
	let expectedHost = "";
	let settle: ((email: string) => void) | null = null;
	let fail: ((error: Error) => void) | null = null;
	const result = new Promise<string>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const server = createServer(async (request, response) => {
		if (request.headers.host !== expectedHost || request.url !== activationPath) {
			send(response, 404, "Not found", "text/plain; charset=utf-8");
			return;
		}
		if (request.method === "GET") {
			send(response, 200, activationPage(activationPath));
			return;
		}
		if (request.method !== "POST" || !isSameOriginActivationPost(request, expectedHost, activationPath)) {
			send(response, 403, "Forbidden", "text/plain; charset=utf-8");
			return;
		}
		try {
			const email = (await readForm(request)).get("email")?.trim() ?? "";
			if (!isEmail(email)) {
				send(response, 400, activationPage(activationPath, "Enter a valid email address."));
				return;
			}
			send(response, 200, completionPage());
			settle?.(email);
			settle = null;
			server.close();
		} catch {
			send(response, 400, activationPage(activationPath, "The activation form could not be read."));
		}
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.maxHeadersCount = 40;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new PluginBootstrapFailure("activation_failed", "Activation did not bind to loopback");
	expectedHost = `127.0.0.1:${address.port}`;
	const url = `http://${expectedHost}${activationPath}`;
	console.log(`AgentMemory activation: ${url}`);
	let opened = false;
	try {
		opened = openUrl(url);
	} catch {
		server.close();
		throw new PluginBootstrapFailure("browser_unavailable", `Open this URL in a browser: ${url}`);
	}
	if (!opened) {
		server.close();
		throw new PluginBootstrapFailure("browser_unavailable", `Open this URL in a browser: ${url}`);
	}
	const timer = setTimeout(() => {
		fail?.(new PluginBootstrapFailure("activation_timeout", "Temporary activation timed out", true));
		server.close();
	}, 5 * 60_000);
	timer.unref();
	try {
		return await result;
	} finally {
		clearTimeout(timer);
		server.close();
	}
}

export class TemporaryPluginBackend implements PluginBootstrapBackendV1 {
	private readonly root: string;
	private readonly coreVersion: string;
	private readonly apiOrigin: string;
	private readonly artifactOrigin: string;
	private readonly fetchImplementation: typeof globalThis.fetch;
	private readonly openUrl: (url: string) => boolean;
	private readonly activate: () => Promise<string>;

	constructor(options: TemporaryPluginBackendOptions = {}) {
		this.root = path.resolve(options.root ?? getDefaultPluginInstallRoot());
		this.coreVersion = options.coreVersion ?? "0.0.0";
		this.apiOrigin = options.apiOrigin ?? API_ORIGIN;
		this.artifactOrigin = options.artifactOrigin ?? ARTIFACT_ORIGIN;
		this.fetchImplementation = options.fetch ?? globalThis.fetch;
		this.openUrl = options.openUrl ?? openLoopbackUrl;
		this.activate = options.activate ?? (() => collectTemporaryActivation(this.openUrl));
	}

	async getLocalEntitlement(): Promise<PluginEntitlementStatusV1> {
		const activation = this.readActivation();
		return activation ? freeEntitlement(activation.dailySessionLimit) : cloneEntitlement(MISSING_ENTITLEMENT);
	}

	async resolveAccess(request: {
		bundleId: string;
		installedVersion?: string;
		channel: string;
		allowAuthentication: boolean;
	}): Promise<PluginAccessDecisionV1> {
		const activation = this.readActivation();
		let email = activation?.email;
		if (!email) {
			if (!request.allowAuthentication)
				return {
					kind: "auth_required",
					entitlement: cloneEntitlement(MISSING_ENTITLEMENT),
					nextAction: {
						kind: "authenticate",
						url: "https://jayzeng.github.io/agentmemory/",
						message: "Run plugin install in an interactive terminal to enter an email address",
					},
				};
			email = await this.activate();
		}
		const response = await this.request(`${this.apiOrigin}/v1/plugin/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 1,
				email,
				bundleId: request.bundleId,
				installedVersion: request.installedVersion ?? null,
				coreVersion: this.coreVersion,
				channel: request.channel,
				platform: process.platform,
				architecture: process.arch,
				consentVersion: "activation-v2",
			}),
		});
		const value = (await readJson(response)) as {
			entitlement?: unknown;
			artifactGrant?: unknown;
			usageCredential?: unknown;
		};
		validatePluginEntitlementStatusV1(value.entitlement);
		if (typeof value.artifactGrant !== "string" || !value.artifactGrant)
			throw new PluginBootstrapFailure("service_response_invalid", "The access response omitted its artifact grant");
		if (typeof value.usageCredential !== "string" || !ACTIVATION_CREDENTIAL.test(value.usageCredential))
			throw new PluginBootstrapFailure(
				"service_response_invalid",
				"The access response omitted its usage credential",
			);
		const freeQuota = value.entitlement.capabilities["session-worker"]?.quota;
		if (
			value.entitlement.plan !== "free" ||
			value.entitlement.state !== "active" ||
			!freeQuota ||
			freeQuota.scope !== "account" ||
			freeQuota.window !== "day"
		)
			throw new PluginBootstrapFailure("service_response_invalid", "The free session policy is invalid");
		this.writeActivation(email, value.usageCredential, freeQuota.limit);
		return { kind: "granted", entitlement: value.entitlement, artifactGrant: value.artifactGrant };
	}

	async reserveSession(operationId: string): Promise<PluginSessionUsageDecisionV1> {
		return this.sessionUsage("reserve", operationId);
	}

	async commitSession(operationId: string): Promise<PluginSessionUsageDecisionV1> {
		return this.sessionUsage("commit", operationId);
	}

	async releaseSession(operationId: string): Promise<PluginSessionUsageDecisionV1> {
		return this.sessionUsage("release", operationId);
	}

	async listReleases(request: {
		bundleId: string;
		channel: string;
		artifactGrant: string;
	}): Promise<SignedPluginReleaseV1[]> {
		const response = await this.request(`${this.apiOrigin}/v1/plugin/releases`, {
			headers: { Authorization: `Bearer ${request.artifactGrant}` },
		});
		const value = (await readJson(response)) as { releases?: unknown };
		if (!Array.isArray(value.releases))
			throw new PluginBootstrapFailure("service_response_invalid", "The release response is invalid");
		return value.releases as SignedPluginReleaseV1[];
	}

	async downloadArtifact(request: { release: SignedPluginReleaseV1; artifactGrant: string }): Promise<Uint8Array> {
		const response = await this.request(`${this.artifactOrigin}/v1/artifacts/download`, {
			headers: { Authorization: `Bearer ${request.artifactGrant}` },
		});
		const declared = Number(response.headers.get("Content-Length"));
		if (Number.isFinite(declared) && declared !== request.release.size)
			throw new PluginBootstrapFailure("artifact_size_mismatch", "The artifact response size is invalid");
		const artifact = await readBoundedBody(response, request.release.size);
		if (artifact.byteLength !== request.release.size)
			throw new PluginBootstrapFailure("artifact_size_mismatch", "The artifact response size is invalid");
		return artifact;
	}

	async getManagementAction(): Promise<PluginNextActionV1 | null> {
		return null;
	}

	private activationPath(): string {
		return path.join(this.root, ...ACTIVATION_FILE.split("/"));
	}

	private readActivation(): TemporaryActivationV1 | null {
		const activationPath = this.activationPath();
		if (!fs.existsSync(activationPath)) return null;
		try {
			const rootStat = fs.lstatSync(this.root);
			const credentialsStat = fs.lstatSync(path.dirname(activationPath));
			if (
				!rootStat.isDirectory() ||
				rootStat.isSymbolicLink() ||
				!credentialsStat.isDirectory() ||
				credentialsStat.isSymbolicLink()
			)
				return null;
			const stat = fs.lstatSync(activationPath);
			if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
				return null;
			const value = JSON.parse(fs.readFileSync(activationPath, "utf-8")) as TemporaryActivationV1;
			if (
				value.schemaVersion !== 2 ||
				!isEmail(value.email) ||
				!Number.isFinite(Date.parse(value.activatedAt)) ||
				!ACTIVATION_CREDENTIAL.test(value.usageCredential) ||
				!Number.isSafeInteger(value.dailySessionLimit) ||
				value.dailySessionLimit <= 0 ||
				value.dailySessionLimit > 10_000
			)
				return null;
			return value;
		} catch {
			return null;
		}
	}

	private writeActivation(email: string, usageCredential: string, dailySessionLimit: number): void {
		if (!isEmail(email)) throw new PluginBootstrapFailure("email_invalid", "Enter a valid email address");
		if (!ACTIVATION_CREDENTIAL.test(usageCredential))
			throw new PluginBootstrapFailure("activation_failed", "The activation credential is invalid");
		if (!Number.isSafeInteger(dailySessionLimit) || dailySessionLimit <= 0 || dailySessionLimit > 10_000)
			throw new PluginBootstrapFailure("activation_failed", "The free session allowance is invalid");
		const target = this.activationPath();
		fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const rootStat = fs.lstatSync(this.root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
			throw new PluginBootstrapFailure("activation_path_invalid", "The plugin activation root is unsafe");
		const directory = path.dirname(target);
		if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
		const directoryStat = fs.lstatSync(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
			throw new PluginBootstrapFailure("activation_path_invalid", "The plugin activation directory is unsafe");
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
		fs.writeFileSync(
			temporary,
			`${JSON.stringify(
				{ schemaVersion: 2, email, activatedAt: new Date().toISOString(), usageCredential, dailySessionLimit },
				null,
				2,
			)}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		fs.renameSync(temporary, target);
	}

	private async sessionUsage(
		action: "reserve" | "commit" | "release",
		operationId: string,
	): Promise<PluginSessionUsageDecisionV1> {
		const activation = this.readActivation();
		if (!activation) throw new PluginBootstrapFailure("auth_required", "Run plugin install to activate AgentMemory");
		const response = await this.request(`${this.apiOrigin}/v1/plugin/sessions/${action}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${activation.usageCredential}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ schemaVersion: 1, operationId }),
		});
		const value = (await readJson(response)) as { decision?: Partial<PluginSessionUsageDecisionV1> };
		const decision = value.decision;
		if (
			!decision ||
			typeof decision.allowed !== "boolean" ||
			!["reserved", "committed", "released", "exhausted", "missing"].includes(String(decision.state)) ||
			!Number.isSafeInteger(decision.limit) ||
			Number(decision.limit) <= 0 ||
			!Number.isSafeInteger(decision.used) ||
			Number(decision.used) < 0 ||
			!Number.isSafeInteger(decision.remaining) ||
			Number(decision.remaining) < 0 ||
			typeof decision.resetAt !== "string" ||
			!Number.isFinite(Date.parse(decision.resetAt)) ||
			typeof decision.idempotent !== "boolean"
		)
			throw new PluginBootstrapFailure("service_response_invalid", "The session usage response is invalid");
		return decision as PluginSessionUsageDecisionV1;
	}

	private async request(url: string, init: RequestInit = {}): Promise<Response> {
		let response: Response;
		try {
			response = await this.fetchImplementation(url, {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: { Accept: "application/json", ...init.headers },
			});
		} catch {
			throw new PluginBootstrapFailure("service_unavailable", "The AgentMemory plugin service is unavailable", true);
		}
		if (!response.ok) {
			let message = `The AgentMemory plugin service returned HTTP ${response.status}`;
			try {
				const value = (await readJson(response)) as { error?: { message?: unknown } };
				if (typeof value.error?.message === "string") message = value.error.message;
			} catch (error) {
				if (error instanceof PluginBootstrapFailure && error.code === "service_response_too_large") throw error;
				// Keep the bounded generic response.
			}
			throw new PluginBootstrapFailure("service_request_failed", message, response.status >= 500);
		}
		return response;
	}
}
