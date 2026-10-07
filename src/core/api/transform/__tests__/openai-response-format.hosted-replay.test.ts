import { describe, expect, it } from "vitest"
import type { ClineAssistantHostedToolBlock, ClineStorageMessage } from "@/shared/messages/content"
import { ServerTool } from "@/shared/proto/dline/models/metadata"
import {
	convertToOpenAIResponsesInput,
	createResponsesWebSearchReplay,
	declaredResponsesHostedToolNames,
} from "../openai-response-format"

const action = { type: "search", query: "Dline release notes", sources: [{ type: "url", url: "https://example.com" }] }
const webSearchCall = { type: "web_search_call", id: "ws_1", status: "completed", action }

function assistantTurn(hosted: ClineAssistantHostedToolBlock): ClineStorageMessage[] {
	return [
		{ role: "user", content: [{ type: "text", text: "What changed?" }] },
		{
			role: "assistant",
			content: [
				{ type: "redacted_thinking", data: "encrypted", provider_metadata: { response_id: "rs_1" } },
				hosted,
				{ type: "text", text: "The release adds hosted replay." },
			],
		},
		{ role: "user", content: [{ type: "text", text: "Summarize the source." }] },
	]
}

const responsesHosted: ClineAssistantHostedToolBlock = {
	type: "hosted_tool",
	protocol: "openai_responses",
	blocks: [webSearchCall],
}

describe("OpenAI Responses hosted tool replay", () => {
	it("sends a stored web_search_call back verbatim between its reasoning and the answer", () => {
		const { input } = convertToOpenAIResponsesInput(assistantTurn(responsesHosted), {
			replayHostedTools: declaredResponsesHostedToolNames([ServerTool.WEB_SEARCH]),
		})

		expect(input.map((item: any) => item.type ?? item.role)).toEqual([
			"user",
			"reasoning",
			"web_search_call",
			"message",
			"user",
		])
		expect(input[2]).toEqual(webSearchCall)
	})

	it("drops the stored call when the request does not declare hosted Web Search", () => {
		for (const replayHostedTools of [undefined, declaredResponsesHostedToolNames([])]) {
			const { input } = convertToOpenAIResponsesInput(assistantTurn(responsesHosted), { replayHostedTools })

			expect(input.some((item: any) => item.type === "web_search_call")).toBe(false)
		}
	})

	it("never sends a hosted call recorded by another protocol", () => {
		const anthropicHosted: ClineAssistantHostedToolBlock = {
			type: "hosted_tool",
			protocol: "anthropic_messages",
			blocks: [
				{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Dline" } },
				{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
			],
		}

		const { input } = convertToOpenAIResponsesInput(assistantTurn(anthropicHosted), {
			replayHostedTools: declaredResponsesHostedToolNames([ServerTool.WEB_SEARCH]),
		})

		expect(JSON.stringify(input)).not.toContain("srvtoolu_1")
		expect(input.map((item: any) => item.type ?? item.role)).toEqual(["user", "reasoning", "message", "user"])
	})

	it("records only the input item fields of a finished call", () => {
		expect(createResponsesWebSearchReplay({ ...webSearchCall, results: [{ url: "https://example.com" }] } as never)).toEqual(
			responsesHosted,
		)
		expect(createResponsesWebSearchReplay({ id: "ws_2", status: "completed" })).toBeUndefined()
	})
})
