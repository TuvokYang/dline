import { describe, expect, it } from "vitest"
import { combineErrorRetryMessages } from "./combineErrorRetryMessages"
import type { ClineMessage } from "./ExtensionMessage"

const exhaustedRetry = (): ClineMessage => ({
	type: "say",
	say: "error_retry",
	text: JSON.stringify({ attempt: 3, maxAttempts: 3, failed: true, errorMessage: "Provider failed" }),
	ts: 1,
	conversationHistoryIndex: 4,
})

const activeRetry = (): ClineMessage => ({
	type: "say",
	say: "error_retry",
	text: JSON.stringify({ attempt: 1, maxAttempts: 3, errorMessage: "Provider failed" }),
	ts: 1,
	conversationHistoryIndex: 0,
})

describe("combineErrorRetryMessages", () => {
	it("keeps an active error while the retry has started but no provider response arrived", () => {
		const messages: ClineMessage[] = [
			activeRetry(),
			{ type: "say", say: "api_req_retried", ts: 2, conversationHistoryIndex: 0 },
		]

		expect(combineErrorRetryMessages(messages)).toContainEqual(messages[0])
	})

	it("retires an active error when same-turn partial reasoning proves the retry stream recovered", () => {
		const messages: ClineMessage[] = [
			activeRetry(),
			{ type: "say", say: "api_req_retried", ts: 2, conversationHistoryIndex: 0 },
			{
				type: "say",
				say: "reasoning",
				text: "Recovered response chunk",
				partial: true,
				ts: 3,
				conversationHistoryIndex: 0,
			},
		]

		expect(combineErrorRetryMessages(messages)).not.toContainEqual(messages[0])
	})

	it("retires an active error when a same-turn partial tool presentation proves recovery", () => {
		const messages: ClineMessage[] = [
			activeRetry(),
			{ type: "say", say: "api_req_retried", ts: 2, conversationHistoryIndex: 0 },
			{
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "README.md" }),
				partial: true,
				ts: 3,
				conversationHistoryIndex: 0,
			},
		]

		expect(combineErrorRetryMessages(messages)).not.toContainEqual(messages[0])
	})

	it("does not treat same-turn local bookkeeping as a recovered provider stream", () => {
		const messages: ClineMessage[] = [
			activeRetry(),
			{ type: "say", say: "api_req_retried", ts: 2, conversationHistoryIndex: 0 },
			{ type: "say", say: "checkpoint_created", ts: 3, conversationHistoryIndex: 0 },
		]

		expect(combineErrorRetryMessages(messages)).toContainEqual(messages[0])
	})

	it("retires an active error when a finalized same-turn follow-up proves recovery", () => {
		const messages: ClineMessage[] = [
			activeRetry(),
			{ type: "say", say: "api_req_retried", ts: 2, conversationHistoryIndex: 0 },
			{
				type: "ask",
				ask: "followup",
				text: JSON.stringify({ question: "Recovered question", options: ["Continue"] }),
				ts: 3,
				conversationHistoryIndex: 0,
				interactionId: "dline_tid_recovered_followup",
			},
		]

		expect(combineErrorRetryMessages(messages)).not.toContainEqual(messages[0])
	})

	it("does not treat a finalized Hosted Web approval as a recovered provider stream", () => {
		const messages: ClineMessage[] = [
			activeRetry(),
			{ type: "say", say: "api_req_retried", ts: 2, conversationHistoryIndex: 0 },
			{
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "webSearch", path: "Allow hosted search" }),
				partial: false,
				ts: 3,
				conversationHistoryIndex: 0,
				interactionId: "hosted-web:task-1:0",
			},
		]

		expect(combineErrorRetryMessages(messages)).toContainEqual(messages[0])
	})

	it("retires automatic retry status when the canonical API recovery ask is shown", () => {
		const messages: ClineMessage[] = [
			activeRetry(),
			{
				type: "ask",
				ask: "api_req_failed",
				text: "Provider failed",
				ts: 2,
				conversationHistoryIndex: 0,
			},
		]

		expect(combineErrorRetryMessages(messages)).toEqual([messages[1]])
	})

	it("keeps exhausted retry status beside the canonical API recovery actions", () => {
		const messages: ClineMessage[] = [
			exhaustedRetry(),
			{
				type: "ask",
				ask: "api_req_failed",
				text: "Provider failed",
				ts: 2,
				conversationHistoryIndex: 4,
			},
		]

		expect(combineErrorRetryMessages(messages)).toEqual(messages)
	})

	it("projects a terminal API error onto its request carrier without removing hosted web history", () => {
		const request: ClineMessage = {
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ request: "Anthropic request", cost: 0 }),
			ts: 1,
		}
		const hostedWebApproval: ClineMessage = {
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "webSearch", path: "Allow Anthropic hosted search" }),
			ts: 2,
		}
		const canonicalError: ClineMessage = {
			type: "ask",
			ask: "api_req_failed",
			text: JSON.stringify({
				message: "Connection error.",
				modelId: "claude-sonnet-4-6",
				providerId: "anthropic",
			}),
			ts: 4,
		}
		const retry = { ...activeRetry(), ts: 3 }
		const messages = [request, hostedWebApproval, retry, canonicalError]

		const result = combineErrorRetryMessages(messages)
		const projectedRequest = result.find((message) => message.say === "api_req_started")

		expect(result).toContainEqual(hostedWebApproval)
		expect(result).toContainEqual(canonicalError)
		expect(result).not.toContainEqual(retry)
		expect(JSON.parse(projectedRequest?.text || "{}")).toMatchObject({
			request: "Anthropic request",
			cost: 0,
			streamingFailedMessage: canonicalError.text,
		})
	})

	it("does not project a stale terminal API error after a manual retry starts", () => {
		const failedRequest: ClineMessage = {
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ request: "Failed request", cost: 0 }),
			ts: 1,
		}
		const canonicalError: ClineMessage = {
			type: "ask",
			ask: "api_req_failed",
			text: "Provider failed",
			ts: 2,
		}
		const retryRequest: ClineMessage = {
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ request: "Manual retry", cost: 0 }),
			ts: 3,
		}

		const result = combineErrorRetryMessages([failedRequest, canonicalError, retryRequest])

		expect(result[0]).toEqual(failedRequest)
		expect(JSON.parse(result[0].text || "{}")).not.toHaveProperty("streamingFailedMessage")
	})

	it("keeps an exhausted error while a manual retry has not produced a durable response", () => {
		const messages: ClineMessage[] = [
			exhaustedRetry(),
			{ type: "say", say: "api_req_started", text: "{}", ts: 2, conversationHistoryIndex: 4 },
		]

		expect(combineErrorRetryMessages(messages)).toContainEqual(messages[0])
	})

	it("retires an exhausted error after a same-turn completion result proves recovery", () => {
		const messages: ClineMessage[] = [
			exhaustedRetry(),
			{ type: "say", say: "api_req_started", text: "{}", ts: 2, conversationHistoryIndex: 4 },
			{ type: "say", say: "completion_result", text: "Recovered", ts: 3, conversationHistoryIndex: 4 },
		]

		expect(combineErrorRetryMessages(messages)).not.toContainEqual(messages[0])
	})

	it("retires an exhausted error after the same-turn completion presentation becomes an ask", () => {
		const messages: ClineMessage[] = [
			exhaustedRetry(),
			{ type: "say", say: "api_req_started", text: "{}", ts: 2, conversationHistoryIndex: 4 },
			{ type: "ask", ask: "completion_result", text: "Recovered", ts: 3, conversationHistoryIndex: 4 },
		]

		expect(combineErrorRetryMessages(messages)).not.toContainEqual(messages[0])
	})
})
