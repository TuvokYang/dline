import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
	type BillingAttributionMessage,
	buildBillingAttributionBlock,
	buildBillingAttributionText,
	CLAUDE_CODE_FINGERPRINT_SALT,
	computeClaudeCodeFingerprint,
	extractFirstUserText,
} from "../billing-attribution"

/**
 * Parity harness for sub2api `backend/internal/service/gateway_billing_block.go`.
 *
 * This is a deliberate second implementation, transliterated from the Go source
 * rather than refactored out of the module under test: it concatenates one
 * buffer and indexes it exactly the way Go indexes a `string`. A divergence in
 * how the production code segments its hash input, trims the version, or pads
 * an out-of-range offset therefore shows up as a mismatch instead of being
 * mirrored by a shared helper.
 */
const GO_SALT = "59cf53e54c78"
const GO_INDICES = [4, 7, 20]
const GO_PADDING = 0x30

function goExtractFirstUserText(messages: readonly BillingAttributionMessage[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue
		const content = message.content
		if (typeof content === "string") return content
		if (Array.isArray(content)) {
			for (const block of content) {
				const candidate = block as { type?: unknown; text?: unknown }
				if (candidate?.type === "text" && typeof candidate.text === "string") return candidate.text
			}
		}
		// Go stops at the first user message even when nothing was extracted.
		return ""
	}
	return ""
}

function goComputeFingerprint(firstUserText: string, version: string): string {
	const bytes = Buffer.from(firstUserText, "utf8")
	const chars = Buffer.from(GO_INDICES.map((index) => (index < bytes.length ? bytes[index] : GO_PADDING)))
	const digest = createHash("sha256").update(Buffer.concat([Buffer.from(GO_SALT, "utf8"), chars, Buffer.from(version, "utf8")]))
	return digest.digest("hex").slice(0, 3)
}

function goBuildAttribution(messages: readonly BillingAttributionMessage[], version: string): string {
	const fingerprint = goComputeFingerprint(goExtractFirstUserText(messages), version)
	return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli;`
}

/** Hashes hand-written sampled bytes, so the expectation never comes from the module under test. */
function fingerprintOfSampledBytes(sampled: Buffer | string, version: string): string {
	const chars = typeof sampled === "string" ? Buffer.from(sampled, "utf8") : sampled
	return createHash("sha256")
		.update(Buffer.concat([Buffer.from(GO_SALT, "utf8"), chars, Buffer.from(version, "utf8")]))
		.digest("hex")
		.slice(0, 3)
}

const VERSION = "2.1.280"

function userText(text: string): BillingAttributionMessage {
	return { role: "user", content: text }
}

describe("extractFirstUserText", () => {
	it("reads a plain string content", () => {
		expect(extractFirstUserText([userText("hello")])).toBe("hello")
	})

	it("skips leading non-user messages", () => {
		const messages: BillingAttributionMessage[] = [
			{ role: "assistant", content: "assistant first" },
			userText("the real first user text"),
		]
		expect(extractFirstUserText(messages)).toBe("the real first user text")
	})

	it("reads the first text block of a content array", () => {
		const messages: BillingAttributionMessage[] = [
			{
				role: "user",
				content: [
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
					{ type: "text", text: "task description" },
					{ type: "text", text: "second block ignored" },
				],
			},
		]
		expect(extractFirstUserText(messages)).toBe("task description")
	})

	it("stops at the first user message even when it carries no text block", () => {
		const messages: BillingAttributionMessage[] = [
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
			userText("later user text must not be used"),
		]
		expect(extractFirstUserText(messages)).toBe("")
	})

	it("returns an empty string when no user message exists", () => {
		expect(extractFirstUserText([{ role: "assistant", content: "only assistant" }])).toBe("")
	})

	it("ignores malformed blocks without throwing", () => {
		const messages: BillingAttributionMessage[] = [
			{ role: "user", content: [null, 42, { type: "text" }, { type: "text", text: "recovered" }] },
		]
		expect(extractFirstUserText(messages)).toBe("recovered")
	})
})

describe("computeClaudeCodeFingerprint", () => {
	it("samples bytes 4, 7 and 20 of the first user text", () => {
		// "Hello, world! This is a test message"
		//   index 4 -> 'o', index 7 -> 'w', index 20 -> 's'
		const expected = fingerprintOfSampledBytes("ows", VERSION)
		expect(computeClaudeCodeFingerprint("Hello, world! This is a test message", VERSION)).toBe(expected)
	})

	it("pads every out-of-range offset with '0'", () => {
		expect(computeClaudeCodeFingerprint("hi", VERSION)).toBe(fingerprintOfSampledBytes("000", VERSION))
	})

	it("pads only the offsets past the end", () => {
		// "0123456789" has bytes at 4 and 7 but not at 20.
		expect(computeClaudeCodeFingerprint("0123456789", VERSION)).toBe(fingerprintOfSampledBytes("470", VERSION))
	})

	it("samples UTF-8 bytes rather than UTF-16 code units", () => {
		// 你好世界这是测试 encodes to three bytes per character, so offsets 4, 7
		// and 20 land inside continuation bytes. Indexing code units instead
		// would sample whole characters and produce a different digest.
		const text = "你好世界这是测试"
		const expected = fingerprintOfSampledBytes(Buffer.from([0xa5, 0xb8, 0x8b]), VERSION)
		expect(computeClaudeCodeFingerprint(text, VERSION)).toBe(expected)

		const utf16Sampled = Buffer.from([text.charCodeAt(4), text.charCodeAt(7), text.charCodeAt(20) || 0x30])
		expect(expected).not.toBe(fingerprintOfSampledBytes(utf16Sampled, VERSION))
	})

	it("changes when the declared version changes", () => {
		const text = "Hello, world! This is a test message"
		expect(computeClaudeCodeFingerprint(text, "2.1.280")).not.toBe(computeClaudeCodeFingerprint(text, "2.1.279"))
	})

	it("is stable across turns because only the first user message feeds it", () => {
		const first = computeClaudeCodeFingerprint(extractFirstUserText([userText("stable opening message")]), VERSION)
		const later = computeClaudeCodeFingerprint(
			extractFirstUserText([
				userText("stable opening message"),
				{ role: "assistant", content: "..." },
				userText("a much later message"),
			]),
			VERSION,
		)
		expect(later).toBe(first)
	})

	it("emits exactly three lowercase hex characters", () => {
		expect(computeClaudeCodeFingerprint("Hello, world! This is a test message", VERSION)).toMatch(/^[0-9a-f]{3}$/)
	})
})

describe("buildBillingAttributionText", () => {
	it("matches the sub2api reference implementation across representative bodies", () => {
		const bodies: BillingAttributionMessage[][] = [
			[userText("Hello, world! This is a test message")],
			[userText("hi")],
			[userText("")],
			[userText("你好世界这是测试")],
			[{ role: "assistant", content: "leading assistant" }, userText("second position user")],
			[{ role: "user", content: [{ type: "text", text: "array shaped first message" }] }],
			[{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }],
			[],
		]
		for (const messages of bodies) {
			expect(buildBillingAttributionText({ messages, clientVersion: VERSION })).toBe(goBuildAttribution(messages, VERSION))
		}
	})

	it("produces the observed upstream shape", () => {
		const text = buildBillingAttributionText({
			messages: [userText("Hello, world! This is a test message")],
			clientVersion: "2.1.162",
		})
		// Observed sample: "x-anthropic-billing-header: cc_version=2.1.162.884; cc_entrypoint=cli;"
		expect(text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.162\.[0-9a-f]{3}; cc_entrypoint=cli;$/)
	})

	it("omits the retired cch segment", () => {
		const text = buildBillingAttributionText({ messages: [userText("anything")], clientVersion: VERSION })
		expect(text).not.toContain("cch=")
	})

	it("supports a non-cli entrypoint", () => {
		// Observed sample: "cc_version=2.1.181.f17; cc_entrypoint=claude-vscode;"
		const text = buildBillingAttributionText({
			messages: [userText("anything")],
			clientVersion: "2.1.181",
			entrypoint: "claude-vscode",
		})
		expect(text).toContain("; cc_entrypoint=claude-vscode;")
	})

	it("falls back to the cli entrypoint for a blank override", () => {
		const text = buildBillingAttributionText({
			messages: [userText("anything")],
			clientVersion: VERSION,
			entrypoint: "   ",
		})
		expect(text).toContain("; cc_entrypoint=cli;")
	})

	it("rejects an empty client version instead of declaring a placeholder", () => {
		expect(() => buildBillingAttributionText({ messages: [userText("anything")], clientVersion: "" })).toThrow(
			/client version/i,
		)
		expect(() => buildBillingAttributionText({ messages: [userText("anything")], clientVersion: "  " })).toThrow(
			/client version/i,
		)
	})

	it("keeps a Dline-shaped first message out of the all-zero fallback", () => {
		// Dline sends the first user turn as a content array, so a string-only
		// implementation would sample nothing and emit one fixed fingerprint
		// for every conversation.
		const dlineShaped: BillingAttributionMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "<task>\nAdd a billing header toggle\n</task>" },
					{ type: "text", text: "<environment_details>...</environment_details>" },
				],
			},
		]
		const degenerate = computeClaudeCodeFingerprint("", VERSION)
		expect(buildBillingAttributionText({ messages: dlineShaped, clientVersion: VERSION })).not.toContain(
			`${VERSION}.${degenerate};`,
		)
	})
})

describe("buildBillingAttributionBlock", () => {
	it("wraps the attribution text as a plain system text block", () => {
		const block = buildBillingAttributionBlock({ messages: [userText("anything")], clientVersion: VERSION })
		expect(block).toEqual({
			type: "text",
			text: buildBillingAttributionText({ messages: [userText("anything")], clientVersion: VERSION }),
		})
	})

	it("attaches no cache_control so the cached prefix is unchanged", () => {
		const block = buildBillingAttributionBlock({ messages: [userText("anything")], clientVersion: VERSION })
		expect(block).not.toHaveProperty("cache_control")
	})
})

describe("salt", () => {
	it("matches the sub2api constant", () => {
		expect(CLAUDE_CODE_FINGERPRINT_SALT).toBe(GO_SALT)
	})
})
