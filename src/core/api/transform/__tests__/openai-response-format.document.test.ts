import { describe, expect, it } from "vitest"
import { anthropicMessagesDocumentLimits, openAiResponsesDocumentLimits } from "@/core/api/document-input-limits"
import type { ModelInfo } from "@/shared/api"
import { convertToOpenAIResponsesInput } from "../openai-response-format"

function modelInfo(supportsImages: boolean, contextWindow = 200_000): ModelInfo {
	return { capabilities: { supportsImages, contextWindow } } as ModelInfo
}

describe("native PDF input", () => {
	it("sends a base64 PDF document as a Responses input_file", () => {
		const { input } = convertToOpenAIResponsesInput([
			{
				role: "user",
				content: [
					{ type: "text", text: "summarize" },
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
						title: "a.pdf",
					},
				],
			},
		])

		expect(input).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "summarize" },
					{ type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,JVBERg==" },
				],
			},
		])
	})

	it("declares the documented provider limits only for image-capable models", () => {
		expect(anthropicMessagesDocumentLimits(modelInfo(false))).toBeUndefined()
		expect(openAiResponsesDocumentLimits(modelInfo(false))).toBeUndefined()

		// 32 MB request minus 2 MB headroom, expressed as decoded bytes of base64 payload.
		expect(anthropicMessagesDocumentLimits(modelInfo(true))).toEqual({ maxTotalBytes: 22_500_000, maxTotalPages: 100 })
		expect(anthropicMessagesDocumentLimits(modelInfo(true, 1_000_000))?.maxTotalPages).toBe(600)
		expect(openAiResponsesDocumentLimits(modelInfo(true))).toEqual({ maxTotalBytes: 50_000_000 })
	})
})
