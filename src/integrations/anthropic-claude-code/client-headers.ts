/**
 * Claude Code client fingerprint headers.
 *
 * The SDK identity values mirror sub2api `backend/internal/pkg/claude/constants.go`
 * `DefaultHeaders`, which in turn mirrors captured CLI traffic. They are declared
 * together because upstream reads them as one identity: a plausible User-Agent
 * next to missing or inconsistent `X-Stainless-*` values is a weaker claim than
 * sending none.
 *
 * The platform values are the exception. sub2api's `Linux`/`arm64` is only its
 * fallback for a client that sent none (`identity_service.go`
 * `createFingerprintFromHeaders`); a real CLI reports the machine it runs on,
 * so Dline reports the host too.
 */

/** Entrypoint segment of the User-Agent, kept aligned with the attribution block. */
export const CLAUDE_CODE_DEFAULT_UA_SUFFIX = "(external, cli)"

/**
 * SDK version bundled by the mimicked Claude Code release.
 *
 * Captured from real Claude Code 2.1.280 traffic, so it is paired with
 * `CLAUDE_CODE_CLIENT_VERSION_FLOOR`: declaring a new CLI next to the SDK an
 * older CLI shipped is a combination no genuine client produces. Raise both
 * together, and only from an observed capture.
 *
 * This value cannot be resolved at runtime. The CLI is published as a bundled
 * package whose npm `dependencies` is empty, so the SDK version exists only
 * inside its build output.
 */
export const CLAUDE_CODE_SDK_VERSION = "0.112.1"

/** The host facts the Stainless platform headers describe. */
export interface ClaudeCodeHostPlatform {
	readonly platform: string
	readonly arch: string
	readonly nodeVersion: string
}

/**
 * Stainless spelling of a Node platform, as the Anthropic SDK reports it.
 *
 * The SDK normalises `process.platform` before sending it, so the raw value
 * (`win32`, `darwin`) would itself be a signature no genuine client produces.
 */
export function stainlessOs(rawPlatform: string): string {
	const platform = rawPlatform.toLowerCase()
	if (platform.includes("ios")) return "iOS"
	switch (platform) {
		case "darwin":
			return "MacOS"
		case "win32":
			return "Windows"
		case "linux":
			return "Linux"
		case "freebsd":
			return "FreeBSD"
		case "openbsd":
			return "OpenBSD"
		case "android":
			return "Android"
		default:
			return platform ? `Other:${platform}` : "Unknown"
	}
}

/**
 * Stainless spelling of a Node architecture, as the Anthropic SDK reports it
 * (`@anthropic-ai/sdk` `internal/detect-platform.ts` `normalizeArch`). Node's
 * `ia32` is deliberately `other:ia32` there, so it is not folded into `x32`.
 */
export function stainlessArch(arch: string): string {
	switch (arch) {
		case "x32":
		case "arm":
			return arch
		case "x64":
		case "x86_64":
			return "x64"
		case "arm64":
		case "aarch64":
			return "arm64"
		default:
			return arch ? `other:${arch}` : "unknown"
	}
}

const currentHostPlatform: ClaudeCodeHostPlatform = {
	platform: process.platform,
	arch: process.arch,
	nodeVersion: process.version,
}

/**
 * Stainless SDK headers sent alongside the User-Agent.
 *
 * `X-Stainless-Retry-Count` and `X-Stainless-Timeout` are deliberately absent
 * here: they describe a specific in-flight attempt, so a fixed value would
 * contradict the observable request. The SDK still emits the real retry count
 * on its own, which is exactly the behaviour a genuine client shows.
 */
export function buildClaudeCodeFingerprintHeaders(
	host: ClaudeCodeHostPlatform = currentHostPlatform,
): Readonly<Record<string, string>> {
	return Object.freeze({
		"X-Stainless-Lang": "js",
		"X-Stainless-Package-Version": CLAUDE_CODE_SDK_VERSION,
		"X-Stainless-OS": stainlessOs(host.platform),
		"X-Stainless-Arch": stainlessArch(host.arch),
		"X-Stainless-Runtime": "node",
		"X-Stainless-Runtime-Version": host.nodeVersion,
		"X-App": "cli",
		"Anthropic-Dangerous-Direct-Browser-Access": "true",
	})
}

/** Fingerprint of the machine this extension host runs on. */
export const CLAUDE_CODE_FINGERPRINT_HEADERS: Readonly<Record<string, string>> = buildClaudeCodeFingerprintHeaders()

/**
 * Builds the declared User-Agent.
 *
 * The version must come from the same resolution that produced the attribution
 * block's `cc_version`. Upstream compares the two, and sub2api rewrites the
 * block to match the User-Agent precisely because a mismatch marks the request
 * as a third-party client.
 *
 * @throws Error when no client version is available, so the caller decides to
 * skip the disguise rather than declare a malformed one.
 */
export function buildClaudeCodeUserAgent(clientVersion: string, entrypointSuffix?: string): string {
	const version = clientVersion.trim()
	if (!version) {
		throw new Error("Claude Code user agent requires a resolved client version")
	}
	const suffix = entrypointSuffix?.trim() || CLAUDE_CODE_DEFAULT_UA_SUFFIX
	return `claude-cli/${version} ${suffix}`
}

/** Returns the complete header set declared to upstream for one request. */
export function buildClaudeCodeClientHeaders(clientVersion: string, entrypointSuffix?: string): Record<string, string> {
	return {
		"User-Agent": buildClaudeCodeUserAgent(clientVersion, entrypointSuffix),
		...CLAUDE_CODE_FINGERPRINT_HEADERS,
	}
}
