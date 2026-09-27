import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { fetch } from "@/shared/net"

/**
 * npm dist-tag endpoint for the Claude Code CLI.
 *
 * Reads `latest` rather than `stable`: on 2026-09-23 `stable` was 2.1.267 while
 * `latest` was 2.1.280, and Anthropic gates new models on the declared client
 * version, so the older tag fails the gate outright.
 */
export const CLAUDE_CODE_CLIENT_VERSION_REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest"

/**
 * Maintained floor used when the registry is unreachable.
 *
 * Anthropic raises the required client version as new models ship, so this
 * constant expires over time. It is a degraded fallback, not the intended
 * source: the resolver prefers the registry and only lands here on failure.
 */
export const CLAUDE_CODE_CLIENT_VERSION_FLOOR = "2.1.280"

export const CLAUDE_CODE_CLIENT_VERSION_SUCCESS_TTL_MS = 60 * 60 * 1000
export const CLAUDE_CODE_CLIENT_VERSION_FAILURE_TTL_MS = 5 * 60 * 1000
export const CLAUDE_CODE_CLIENT_VERSION_REQUEST_TIMEOUT_MS = 5_000

/**
 * Strict three-part numeric version.
 *
 * Prerelease and build metadata are rejected on purpose: upstream validates the
 * declared version against this exact shape, and a `-local` or `+build` suffix
 * marks the request as an unofficial client.
 */
const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export type ClaudeCodeClientVersionSource = "registry" | "cache" | "floor"

export interface ClaudeCodeClientVersionResolution {
	readonly version: string
	readonly source: ClaudeCodeClientVersionSource
}

export interface ClaudeCodeClientVersionResolverOptions {
	readonly fetchImpl?: typeof globalThis.fetch
	readonly now?: () => number
	readonly registryUrl?: string
	readonly floorVersion?: string
	readonly successTtlMs?: number
	readonly failureTtlMs?: number
	readonly timeoutMs?: number
}

interface CacheEntry {
	readonly resolution: ClaudeCodeClientVersionResolution
	readonly expiresAt: number
}

/** Reports whether a version string is acceptable as a declared client version. */
export function isSupportedClaudeCodeClientVersion(value: string): boolean {
	return STRICT_SEMVER_PATTERN.test(value.trim())
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".").map(Number)
	const rightParts = right.split(".").map(Number)
	for (let index = 0; index < 3; index++) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
		if (difference !== 0) return difference < 0 ? -1 : 1
	}
	return 0
}

function readRegistryVersion(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined
	const version = (payload as { version?: unknown }).version
	if (typeof version !== "string") return undefined
	return isSupportedClaudeCodeClientVersion(version) ? version.trim() : undefined
}

/**
 * Resolves the Claude Code CLI version declared to Anthropic upstream.
 *
 * Resolution never blocks a request: a registry failure degrades to the cached
 * value and then to the maintained floor. The floor also acts as a lower bound
 * on the registry answer, so a yanked or rolled-back publish cannot drag the
 * declared version below a version already known to pass the gate.
 */
export class ClaudeCodeClientVersionResolver {
	private readonly fetchImpl: typeof globalThis.fetch
	private readonly now: () => number
	private readonly registryUrl: string
	private readonly floorVersion: string
	private readonly successTtlMs: number
	private readonly failureTtlMs: number
	private readonly timeoutMs: number
	private cache?: CacheEntry
	private inFlight?: Promise<ClaudeCodeClientVersionResolution>

	constructor(options: ClaudeCodeClientVersionResolverOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? fetch
		this.now = options.now ?? (() => Date.now())
		this.registryUrl = options.registryUrl ?? CLAUDE_CODE_CLIENT_VERSION_REGISTRY_URL
		this.floorVersion = options.floorVersion ?? CLAUDE_CODE_CLIENT_VERSION_FLOOR
		this.successTtlMs = options.successTtlMs ?? CLAUDE_CODE_CLIENT_VERSION_SUCCESS_TTL_MS
		this.failureTtlMs = options.failureTtlMs ?? CLAUDE_CODE_CLIENT_VERSION_FAILURE_TTL_MS
		this.timeoutMs = options.timeoutMs ?? CLAUDE_CODE_CLIENT_VERSION_REQUEST_TIMEOUT_MS
	}

	/** Returns the declared version, refreshing from the registry when the cache expired. */
	async resolve(signal?: AbortSignal): Promise<ClaudeCodeClientVersionResolution> {
		const cached = this.cache
		if (cached && cached.expiresAt > this.now()) {
			return cached.resolution
		}
		// Collapse concurrent callers onto one registry request so a burst of
		// requests cannot multiply outbound traffic.
		this.inFlight ??= this.refresh(signal).finally(() => {
			this.inFlight = undefined
		})
		return this.inFlight
	}

	private async refresh(signal?: AbortSignal): Promise<ClaudeCodeClientVersionResolution> {
		const registryVersion = await this.fetchRegistryVersion(signal)
		if (registryVersion) {
			// The floor wins over a lower registry answer; see the class comment.
			const selected = compareVersions(registryVersion, this.floorVersion) >= 0 ? registryVersion : this.floorVersion
			return this.store({ version: selected, source: "registry" }, this.successTtlMs)
		}
		const previous = this.cache?.resolution
		if (previous) {
			return this.store({ version: previous.version, source: "cache" }, this.failureTtlMs)
		}
		return this.store({ version: this.floorVersion, source: "floor" }, this.failureTtlMs)
	}

	private async fetchRegistryVersion(signal?: AbortSignal): Promise<string | undefined> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		const onAbort = () => controller.abort()
		signal?.addEventListener("abort", onAbort, { once: true })
		try {
			const response = await this.fetchImpl(this.registryUrl, {
				headers: buildExternalBasicHeaders(),
				signal: controller.signal,
			})
			if (!response.ok) return undefined
			return readRegistryVersion(await response.json())
		} catch {
			// Any failure degrades to the cached value or the floor; resolution
			// must not surface an error into the request path.
			return undefined
		} finally {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
		}
	}

	private store(resolution: ClaudeCodeClientVersionResolution, ttlMs: number): ClaudeCodeClientVersionResolution {
		this.cache = { resolution, expiresAt: this.now() + ttlMs }
		return resolution
	}
}

let sharedResolver: ClaudeCodeClientVersionResolver | undefined

/** Returns the process-wide resolver so every caller observes one cached version. */
export function getClaudeCodeClientVersionResolver(): ClaudeCodeClientVersionResolver {
	sharedResolver ??= new ClaudeCodeClientVersionResolver()
	return sharedResolver
}

/** Test seam: drops the shared resolver so a suite starts from a cold cache. */
export function resetClaudeCodeClientVersionResolver(): void {
	sharedResolver = undefined
}
