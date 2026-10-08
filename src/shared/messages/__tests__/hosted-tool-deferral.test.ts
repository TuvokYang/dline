import type { ClineAssistantHostedToolBlock, ClineStorageMessage } from "@shared/messages/content"
import { resolveDeferredHostedCalls } from "@shared/messages/hosted-tool-deferral"
import { describe, expect, it } from "vitest"

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

const declared = { protocol: "anthropic_messages" as const, replayHostedTools: new Set(["web_search"]) }

function deferredTurn(followUp: ClineStorageMessage["content"]): ClineStorageMessage[] {
	return [
		{ role: "user", content: "Research and read" },
		{ role: "assistant", content: [callSegment, { type: "text", text: "Searching and reading." }, toolUse] },
		{ role: "user", content: followUp },
	]
}

describe("resolveDeferredHostedCalls", () => {
	it("keeps a deferred call pending while the request that answers its client tools is being built", () => {
		const messages = deferredTurn([toolResult, { type: "text", text: "<environment_details>x</environment_details>" }])

		expect(resolveDeferredHostedCalls(messages, declared)).toEqual([
			{ callId: "srvtoolu_deferred", toolName: "web_search", messageIndex: 1, followUpIndices: [2], state: "pending" },
		])
	})

	it("marks a deferred call resumed once the following assistant turn starts with its result", () => {
		const messages: ClineStorageMessage[] = [
			...deferredTurn([toolResult]),
			{ role: "assistant", content: [resultSegment, { type: "text", text: "Found it." }] },
		]

		expect(resolveDeferredHostedCalls(messages, declared)).toEqual([
			{ callId: "srvtoolu_deferred", toolName: "web_search", messageIndex: 1, followUpIndices: [2], state: "resumed" },
		])
	})

	// The task journal stores a round's tool results and its environment details as separate user messages.
	it("reads consecutive user messages after the deferred turn as one follow-up turn", () => {
		const environment: ClineStorageMessage = {
			role: "user",
			content: [{ type: "text", text: "<environment_details>x</environment_details>" }],
		}
		const pending = [...deferredTurn([toolResult]), environment]
		const resumed: ClineStorageMessage[] = [
			...pending,
			{ role: "assistant", content: [resultSegment, { type: "text", text: "Found it." }] },
		]

		expect(resolveDeferredHostedCalls(pending, declared)).toEqual([
			{ callId: "srvtoolu_deferred", toolName: "web_search", messageIndex: 1, followUpIndices: [2, 3], state: "pending" },
		])
		expect(resolveDeferredHostedCalls(resumed, declared)[0]?.state).toBe("resumed")
	})

	it("drops a deferred call whose follow-up run does not open with its tool results", () => {
		const messages: ClineStorageMessage[] = [
			...deferredTurn([{ type: "text", text: "Never mind" }]),
			{ role: "user", content: [toolResult] },
		]

		expect(resolveDeferredHostedCalls(messages, declared)[0]?.state).toBe("dropped")
	})

	it("drops a deferred call whose follow-up user message carries no tool result", () => {
		const messages = deferredTurn([{ type: "text", text: "Never mind" }])

		expect(resolveDeferredHostedCalls(messages, declared)[0]?.state).toBe("dropped")
	})

	it("drops a deferred call when the next assistant turn did not start with its result", () => {
		const messages: ClineStorageMessage[] = [
			...deferredTurn([toolResult]),
			{ role: "assistant", content: [{ type: "text", text: "Interrupted answer" }] },
		]

		expect(resolveDeferredHostedCalls(messages, declared)[0]?.state).toBe("dropped")
	})

	it("drops a deferred call the request cannot replay", () => {
		const messages = deferredTurn([toolResult])

		for (const options of [
			{ protocol: "anthropic_messages" as const },
			{ protocol: "anthropic_messages" as const, replayHostedTools: new Set(["web_fetch"]) },
			{ protocol: "openai_responses" as const, replayHostedTools: new Set(["web_search"]) },
		]) {
			expect(resolveDeferredHostedCalls(messages, options)[0]?.state).toBe("dropped")
		}
	})

	it("ignores hosted calls stored together with their result", () => {
		const paired: ClineAssistantHostedToolBlock = {
			type: "hosted_tool",
			protocol: "anthropic_messages",
			blocks: [call, result],
		}
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "Search" },
			{ role: "assistant", content: [paired, { type: "text", text: "Done" }] },
		]

		expect(resolveDeferredHostedCalls(messages, declared)).toEqual([])
	})
})
