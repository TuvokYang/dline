/**
 * `anthropic-beta` values sent by the Claude Code subscription client.
 *
 * Upstream classifies the caller by the *complete* beta set rather than by any
 * single header. A request that omits a value the real client always sends is
 * billed against third-party usage instead of the plan, and one that omits the
 * OAuth beta is rejected outright. The set is therefore a fixed client
 * fingerprint, not a per-request capability declaration.
 */

/** Beta that authorizes a subscription OAuth token for inference. */
export const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20"

/**
 * The beta set every subscription request declares, in real client order.
 *
 * Derived from the Claude Code client fingerprint rather than from what a
 * given request happens to use: deriving members from the request would make
 * the set vary per turn, and that variation is itself observable.
 */
export const CLAUDE_CODE_CLIENT_BETAS: readonly string[] = [
	"claude-code-20250219",
	CLAUDE_CODE_OAUTH_BETA,
	"interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05",
	"effort-2025-11-24",
	"context-management-2025-06-27",
	"thinking-binding-controls-2026-08-01",
	"mid-conversation-output-config-2026-07-01",
	"extended-cache-ttl-2025-04-11",
]

/**
 * Returns the beta set for one subscription request.
 *
 * Deliberately excludes `redact-thinking`: the real client does not declare it
 * by default, and it lets upstream strip thinking content from the response.
 * The metered long-context beta is excluded for the same reason it is absent
 * from the model catalog — a subscription cannot buy that window.
 */
export function buildClaudeCodeBetas(): string[] {
	return [...CLAUDE_CODE_CLIENT_BETAS]
}

/** Renders the beta set as the `anthropic-beta` header value. */
export function buildClaudeCodeBetaHeader(): string {
	return buildClaudeCodeBetas().join(",")
}
