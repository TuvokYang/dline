import type { ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import { describe, expect, it, vi } from "vitest"
import type { InteractionKind } from "../Interaction"
import { projectInteractionContinuation, statusFeedbackText } from "../InteractionContinuation"

const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const IMAGE_URL = `data:image/png;base64,${IMAGE_DATA}`
const PDF_DATA = "JVBERi0xLjQKJSVFT0YK"

const pdfDocument: ClineUserAttachedDocumentBlock = {
	type: "attached_document",
	path: "/work/spec.pdf",
	media_type: "application/pdf",
	data: PDF_DATA,
	byte_length: 16,
	page_count: 1,
	fallback_text: '<file_content path="/work/spec.pdf">\nHello PDF\n</file_content>',
}

// The extractor is the file-system boundary; the continuation contract only depends on its split result.
vi.mock("@integrations/misc/extract-text", () => ({
	processFilesForToolResult: async (files?: string[]) =>
		files?.length
			? {
					text: "Files attached by the user:\n\n(The attached PDFs follow this tool result as documents.)",
					documents: [pdfDocument],
				}
			: { text: "", documents: [] },
}))

const KINDS: InteractionKind[] = [
	"followup",
	"make_plan",
	"qna_response",
	"generate_report",
	"status_acknowledgment",
	"completion",
]

function textOf(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.map((block) => (block?.type === "text" ? block.text : "")).join("\n")
}

describe("projectInteractionContinuation attachments", () => {
	it.each(KINDS)("%s sends images as native image blocks and never as data URLs in text", async (kind) => {
		const { toolResult, documents } = await projectInteractionContinuation({
			kind,
			functionId: "call-1",
			dlineTid: "tid-1",
			chatContent: { message: "looks good", images: [IMAGE_URL] },
		})

		expect(documents).toEqual([])
		expect(Array.isArray(toolResult.content)).toBe(true)
		expect(toolResult.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image",
					source: expect.objectContaining({ type: "base64", media_type: "image/png", data: IMAGE_DATA }),
				}),
			]),
		)
		expect(textOf(toolResult.content)).not.toContain("data:image")
		expect(textOf(toolResult.content)).not.toContain(IMAGE_DATA)
	})

	it.each(KINDS)("%s returns attached PDFs beside the tool result instead of inside its text", async (kind) => {
		const { toolResult, documents } = await projectInteractionContinuation({
			kind,
			functionId: "call-2",
			dlineTid: "tid-2",
			chatContent: { message: "see the spec", files: ["/work/spec.pdf"] },
		})

		expect(documents).toEqual([pdfDocument])
		expect(toolResult).toMatchObject({ type: "tool_result", function_id: "call-2", dline_tid: "tid-2" })
		expect(textOf(toolResult.content)).toContain("follow this tool result as documents")
		expect(textOf(toolResult.content)).not.toContain(PDF_DATA)
		expect(textOf(toolResult.content)).not.toContain("Hello PDF")
	})
})

describe("statusFeedbackText", () => {
	it("wraps only the trimmed feedback text", () => {
		expect(statusFeedbackText("  keep going  ")).toBe("\n<feedback>\nkeep going\n</feedback>")
		expect(statusFeedbackText("   ")).toBe("")
		expect(statusFeedbackText(undefined)).toBe("")
	})
})
