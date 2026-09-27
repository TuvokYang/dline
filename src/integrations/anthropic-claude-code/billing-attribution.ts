import { createHash } from "node:crypto"

/**
 * Builds the Claude Code billing attribution block.
 *
 * Upstream reads the attribution as a `text` block inside the request `system`
 * array, not as an HTTP header, despite the `x-anthropic-billing-header:`
 * prefix inside the text. Emitting it as a real header has no effect.
 *
 * The algorithm mirrors sub2api `backend/internal/service/gateway_billing_block.go`
 * so a request built here is indistinguishable from one built by that gateway.
 */

/** Salt prefixed to the sampled characters before hashing. */
export const CLAUDE_CODE_FINGERPRINT_SALT = "59cf53e54c78"

/**
 * Byte offsets sampled from the first user message.
 *
 * These are byte offsets, not UTF-16 code unit offsets: upstream indexes a Go
 * `string`, which is a byte sequence. A multi-byte first message therefore
 * samples bytes in the middle of a rune, and reproducing that exactly is the
 * point.
 */
export const CLAUDE_CODE_FINGERPRINT_SAMPLE_OFFSETS: readonly number[] = [4, 7, 20]

/** Byte substituted when an offset is past the end of the first user message. */
export const CLAUDE_CODE_FINGERPRINT_PADDING_BYTE = 0x30 // '0'

/** Hex characters kept from the digest. */
export const CLAUDE_CODE_FINGERPRINT_LENGTH = 3

/** Entrypoint declared when the caller does not override it. */
export const CLAUDE_CODE_DEFAULT_ENTRYPOINT = "cli"

/**
 * Minimal structural view of an Anthropic request message.
 *
 * The attribution is derived from the outbound request body, so this accepts
 * the wire shape rather than a Dline domain type: both the anthropic provider
 * and the claude-code provider hand over already-serialized messages.
 */
export interface BillingAttributionMessage {
	readonly role?: unknown
	readonly content?: unknown
}

export interface BillingAttributionInput {
	readonly messages: readonly BillingAttributionMessage[]
	readonly clientVersion: string
	readonly entrypoint?: string
}

export interface BillingAttributionTextBlock {
	readonly type: "text"
	readonly text: string
}

function readTextBlock(block: unknown): string | undefined {
	if (typeof block !== "object" || block === null) return undefined
	const candidate = block as { type?: unknown; text?: unknown }
	if (candidate.type !== "text") return undefined
	return typeof candidate.text === "string" ? candidate.text : undefined
}

/**
 * Returns the text of the first user message, or an empty string.
 *
 * Scanning stops at the first `user` message even when no text is recoverable
 * from it, matching upstream. A tool-result-only or image-only first message
 * therefore yields an empty string rather than falling through to a later
 * message.
 */
export function extractFirstUserText(messages: readonly BillingAttributionMessage[]): string {
	for (const message of messages) {
		if (message?.role !== "user") continue
		const { content } = message
		if (typeof content === "string") return content
		if (Array.isArray(content)) {
			for (const block of content) {
				const text = readTextBlock(block)
				if (text !== undefined) return text
			}
		}
		return ""
	}
	return ""
}

function sampleFingerprintBytes(firstUserText: string): Buffer {
	const source = Buffer.from(firstUserText, "utf8")
	const sampled = Buffer.alloc(CLAUDE_CODE_FINGERPRINT_SAMPLE_OFFSETS.length)
	CLAUDE_CODE_FINGERPRINT_SAMPLE_OFFSETS.forEach((offset, position) => {
		sampled[position] = offset < source.length ? source[offset] : CLAUDE_CODE_FINGERPRINT_PADDING_BYTE
	})
	return sampled
}

/**
 * Derives the fingerprint suffix appended to the declared client version.
 *
 * The digest covers the salt, the three sampled bytes and the version, so the
 * value is stable for the whole conversation: only the first user message and
 * the declared version feed it.
 */
export function computeClaudeCodeFingerprint(firstUserText: string, clientVersion: string): string {
	const digest = createHash("sha256")
		.update(Buffer.from(CLAUDE_CODE_FINGERPRINT_SALT, "utf8"))
		.update(sampleFingerprintBytes(firstUserText))
		.update(Buffer.from(clientVersion, "utf8"))
		.digest("hex")
	return digest.slice(0, CLAUDE_CODE_FINGERPRINT_LENGTH)
}

/**
 * Assembles the attribution text.
 *
 * @throws Error when no client version is available. Declaring an empty or
 * placeholder version is worse than omitting the block, because upstream then
 * sees a malformed official-client claim, so the caller must decide to skip
 * attribution instead of receiving a degraded value.
 */
export function buildBillingAttributionText(input: BillingAttributionInput): string {
	const clientVersion = input.clientVersion.trim()
	if (!clientVersion) {
		throw new Error("Claude Code billing attribution requires a resolved client version")
	}
	const entrypoint = input.entrypoint?.trim() || CLAUDE_CODE_DEFAULT_ENTRYPOINT
	const fingerprint = computeClaudeCodeFingerprint(extractFirstUserText(input.messages), clientVersion)
	// The retired `cch=` segment is deliberately absent: current clients stopped
	// sending it, so re-adding it would diverge from real traffic.
	return `x-anthropic-billing-header: cc_version=${clientVersion}.${fingerprint}; cc_entrypoint=${entrypoint};`
}

/**
 * Wraps the attribution text as a system block.
 *
 * No `cache_control` is attached: the block is not a cache breakpoint, and
 * marking it would change the cached prefix of every request.
 */
export function buildBillingAttributionBlock(input: BillingAttributionInput): BillingAttributionTextBlock {
	return { type: "text", text: buildBillingAttributionText(input) }
}
