import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import { describe, expect, it } from "vitest"
import { projectInteractionContinuation } from "../InteractionContinuation"

function textOf(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((block) => (block?.type === "text" ? [block.text as string] : [])).join("")
}

describe("projectInteractionContinuation", () => {
	// A restored or resumed reply becomes the tool's result just as a live one
	// does, so it is held to the same per-result ceiling.
	it("bounds an oversized reply to the canonical tool result limit", async () => {
		const result = await projectInteractionContinuation({
			kind: "qna_response",
			functionId: "call-qna",
			dlineTid: "tid-qna",
			chatContent: { message: "x".repeat(MAX_TOOL_RESULT_TEXT_BYTES * 2) },
		})

		const text = textOf(result.toolResult.content)
		expect(text.startsWith("<feedback>\n")).toBe(true)
		expect(text).toContain("[FILE TRUNCATED:")
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
	})

	it("keeps a reply within the limit unchanged", async () => {
		const result = await projectInteractionContinuation({
			kind: "followup",
			functionId: "call-ask",
			dlineTid: "tid-ask",
			chatContent: { message: "short answer" },
		})

		expect(textOf(result.toolResult.content)).toBe("<feedback>\nshort answer\n</feedback>")
		expect(result.documents).toEqual([])
	})
})
