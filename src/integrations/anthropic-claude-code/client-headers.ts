/**
 * Claude Code client fingerprint headers.
 *
 * Values mirror sub2api `backend/internal/pkg/claude/constants.go` `DefaultHeaders`,
 * which in turn mirrors captured CLI traffic. They are declared together because
 * upstream reads them as one identity: a plausible User-Agent next to missing or
 * inconsistent `X-Stainless-*` values is a weaker claim than sending none.
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

/**
 * Stainless SDK headers sent alongside the User-Agent.
 *
 * `X-Stainless-Retry-Count` and `X-Stainless-Timeout` are deliberately absent
 * here: they describe a specific in-flight attempt, so a fixed value would
 * contradict the observable request. The SDK still emits the real retry count
 * on its own, which is exactly the behaviour a genuine client shows.
 */
export const CLAUDE_CODE_FINGERPRINT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	"X-Stainless-Lang": "js",
	"X-Stainless-Package-Version": CLAUDE_CODE_SDK_VERSION,
	"X-Stainless-OS": "Linux",
	"X-Stainless-Arch": "arm64",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": "v24.3.0",
	"X-App": "cli",
	"Anthropic-Dangerous-Direct-Browser-Access": "true",
})

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
