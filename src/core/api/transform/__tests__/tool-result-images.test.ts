import { describe, expect, it } from "vitest"
import type { ClineStorageMessage, ClineToolResponseContent } from "@/shared/messages/content"
import { convertDeepSeekMessages, convertDeepSeekResponsesInput } from "../deepseek-format"
import { convertAnthropicContentToGemini } from "../gemini-format"
import { convertToOllamaMessages } from "../ollama-format"
import { convertToOpenAIResponsesInput } from "../openai-response-format"

// A 1x1 PNG. Any wire field that should hold text must never contain it.
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const IMAGE_URL = `data:image/png;base64,${IMAGE_DATA}`
const TEXT_KEYS = new Set(["text", "output", "content", "result"])

const imageResult: ClineToolResponseContent = [
	{ type: "text", text: "<feedback>look at this</feedback>" },
	{ type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } },
]

function toolTurn(content: ClineToolResponseContent, options: { withCall?: boolean } = {}): ClineStorageMessage[] {
	const call: ClineStorageMessage = {
		role: "assistant",
		content: [{ type: "tool_use", function_id: "call_1", dline_tid: "tid_1", name: "ask_followup_question", input: {} }],
	}
	const result: ClineStorageMessage = {
		role: "user",
		content: [{ type: "tool_result", function_id: "call_1", dline_tid: "tid_1", content }],
	}
	return options.withCall === false ? [result] : [call, result]
}

/** Every string held by a text-bearing field anywhere in the projected request. */
function textFields(value: unknown, found: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) textFields(item, found)
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (typeof child === "string" && TEXT_KEYS.has(key)) found.push(child)
			else textFields(child, found)
		}
	}
	return found
}

function expectNoBase64InText(projected: unknown) {
	for (const text of textFields(projected)) {
		expect(text).not.toContain(IMAGE_DATA)
	}
}

describe("tool result images reach every protocol as images, never as base64 text", () => {
	it("OpenAI Responses sends the image as a native input_image inside the function output", () => {
		const { input } = convertToOpenAIResponsesInput(toolTurn(imageResult))

		expect(input).toContainEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: [
				{ type: "input_text", text: "<feedback>look at this</feedback>" },
				{ type: "input_image", detail: "auto", image_url: IMAGE_URL },
			],
		})
		expectNoBase64InText(input)
	})

	it("OpenAI Responses keeps a text-only result as plain text instead of serialized blocks", () => {
		const { input } = convertToOpenAIResponsesInput(
			toolTurn([
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			]),
		)

		expect(input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "first\nsecond" })
	})

	it("OpenAI Responses keeps the image native when an orphaned result is demoted to user content", () => {
		const { input } = convertToOpenAIResponsesInput(toolTurn(imageResult, { withCall: false }))

		expect(JSON.stringify(input)).not.toContain("function_call_output")
		expect(input).toContainEqual({
			role: "user",
			content: [
				{ type: "input_text", text: "<feedback>look at this</feedback>" },
				{ type: "input_image", detail: "auto", image_url: IMAGE_URL },
			],
		})
		expectNoBase64InText(input)
	})

	it("DeepSeek Responses sends the image in the following user message", () => {
		const input = convertDeepSeekResponsesInput(toolTurn(imageResult))

		const output = input.find((item) => "type" in item && item.type === "function_call_output")
		expect(output).toMatchObject({ call_id: "call_1", output: expect.stringContaining("look at this") })
		expect(input.at(-1)).toEqual({
			role: "user",
			content: [{ type: "input_image", detail: "auto", image_url: IMAGE_URL }],
		})
		expectNoBase64InText(input)
	})

	it("DeepSeek chat sends the tool image as an image part instead of dropping it", () => {
		const messages = convertDeepSeekMessages(toolTurn(imageResult), "system")

		const tool = messages.find((message) => message.role === "tool")
		expect(tool?.content).toContain("look at this")
		expect(messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "image_url", image_url: { url: IMAGE_URL } }],
		})
		expectNoBase64InText(messages)
	})

	it("Gemini answers the call with text and follows it with the image as inline data", () => {
		const parts = convertAnthropicContentToGemini(toolTurn(imageResult)[1].content)

		expect(parts).toEqual([
			{
				functionResponse: {
					name: "call_1",
					response: { result: "<feedback>look at this</feedback>\n(see following user message for image)" },
				},
			},
			{ inlineData: { data: IMAGE_DATA, mimeType: "image/png" } },
		])
	})

	it("Ollama puts tool and user images in the images field of their own message", () => {
		const messages = convertToOllamaMessages([
			...toolTurn(imageResult),
			{
				role: "user",
				content: [
					{ type: "text", text: "and this one" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } },
				],
			},
		])
		const userMessages = messages.filter((message) => message.role === "user")

		expect(userMessages).toEqual([
			{ role: "user", images: [IMAGE_DATA], content: expect.stringContaining("look at this") },
			{ role: "user", images: [IMAGE_DATA], content: "and this one" },
		])
		expectNoBase64InText(messages)
	})
})
