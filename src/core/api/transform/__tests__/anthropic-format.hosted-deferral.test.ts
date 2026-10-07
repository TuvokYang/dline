import type { ClineAssistantHostedToolBlock, ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { sanitizeAnthropicMessages } from "../anthropic-format"

const call = {
	type: "server_tool_use",
	id: "srvtoolu_deferred",
	name: "web_search",
	input: { query: "deferred search" },
	caller: { type: "direct" },
}
const result = {
	type: "web_search_tool_result",
	tool_use_id: "srvtoolu_deferred",
	content: [],
	caller: { type: "direct" },
}
const callSegment: ClineAssistantHostedToolBlock = {
	type: "hosted_tool",
	protocol: "anthropic_messages",
	segment: "call",
	blocks: [call],
}
const resultSegment: ClineAssistantHostedToolBlock = {
	type: "hosted_tool",
	protocol: "anthropic_messages",
	segment: "result",
	blocks: [result],
}
const toolUse = {
	type: "tool_use" as const,
	id: "toolu_read",
	name: "read_file",
	input: { path: "a.ts" },
	function_id: "toolu_read",
	dline_tid: "tid-read",
}
const toolResult = {
	type: "tool_result" as const,
	tool_use_id: "toolu_read",
	content: "file body",
	function_id: "toolu_read",
	dline_tid: "tid-read",
}
const environment = { type: "text" as const, text: "<environment_details>x</environment_details>" }
const replayWebSearch = { replayHostedTools: new Set(["web_search"]) }

const deferredHistory: ClineStorageMessage[] = [
	{ role: "user", content: "Research and read" },
	{ role: "assistant", content: [callSegment, { type: "text", text: "Searching and reading." }, toolUse] },
	{ role: "user", content: [toolResult, environment] },
]

describe("sanitizeAnthropicMessages deferred hosted calls", () => {
	it("keeps the deferred call and leaves only tool results in the follow-up user message", () => {
		const projected = sanitizeAnthropicMessages(deferredHistory, false, replayWebSearch)

		expect(projected[1].content).toEqual([
			call,
			{ type: "text", text: "Searching and reading." },
			expect.objectContaining({ type: "tool_use", id: "toolu_read" }),
		])
		expect(projected[2].content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu_read",
				content: [{ type: "text", text: "file body" }, environment],
			},
		])
	})

	it("places the prompt-cache breakpoint on the folded tool result", () => {
		const projected = sanitizeAnthropicMessages(deferredHistory, true, replayWebSearch)
		const followUp = projected[2].content as unknown as Array<Record<string, unknown>>

		expect(followUp).toHaveLength(1)
		expect(followUp[0]).toMatchObject({ type: "tool_result", cache_control: { type: "ephemeral" } })
	})

	it("appends folded blocks after array tool-result content in their original order", () => {
		const image = {
			type: "image" as const,
			source: { type: "base64" as const, media_type: "image/png" as const, data: "AA==" },
		}
		const history: ClineStorageMessage[] = [
			...deferredHistory.slice(0, 2),
			{
				role: "user",
				content: [{ ...toolResult, content: [{ type: "text", text: "file body" }] }, image, environment],
			},
		]

		const projected = sanitizeAnthropicMessages(history, false, replayWebSearch)

		expect(projected[2].content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu_read",
				content: [{ type: "text", text: "file body" }, image, environment],
			},
		])
	})

	it("replays a resumed exchange in order and serializes the earlier turns identically on every request", () => {
		const resumedHistory: ClineStorageMessage[] = [
			...deferredHistory,
			{ role: "assistant", content: [resultSegment, { type: "text", text: "Found it." }] },
			{ role: "user", content: "Thanks" },
		]

		const pendingRequest = sanitizeAnthropicMessages(deferredHistory, false, replayWebSearch)
		const laterRequest = sanitizeAnthropicMessages(resumedHistory, false, replayWebSearch)

		expect(laterRequest.slice(0, 3)).toEqual(pendingRequest)
		expect(laterRequest[3].content).toEqual([result, { type: "text", text: "Found it." }])
	})

	it("removes a deferred call that can no longer be resumed and leaves its follow-up untouched", () => {
		const history: ClineStorageMessage[] = [
			...deferredHistory.slice(0, 2),
			{ role: "user", content: [{ type: "text", text: "Never mind" }] },
		]

		const projected = sanitizeAnthropicMessages(history, false, replayWebSearch)

		expect((projected[1].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "tool_use"])
		expect(projected[2].content).toEqual([{ type: "text", text: "Never mind" }])
	})

	it("removes an orphaned result segment whose call is no longer in the request", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: "Continue" },
			{ role: "assistant", content: [resultSegment, { type: "text", text: "Found it." }] },
		]

		const projected = sanitizeAnthropicMessages(history, false, replayWebSearch)

		expect(projected[1].content).toEqual([{ type: "text", text: "Found it." }])
	})

	it("drops the deferred call and keeps the follow-up unchanged when the request does not declare the tool", () => {
		const projected = sanitizeAnthropicMessages(deferredHistory, false, { replayHostedTools: new Set(["web_fetch"]) })

		expect((projected[1].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "tool_use"])
		expect((projected[2].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["tool_result", "text"])
	})
})
