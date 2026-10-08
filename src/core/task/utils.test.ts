import type { ApiHandler } from "@core/api"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import type { MessageStateHandler } from "./message-state"
import { updateApiReqMsg } from "./utils"

describe("updateApiReqMsg", () => {
	it("keeps a valid requested API message index when a later request exists", async () => {
		const messages: UiMessage[] = [
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ request: "current request" }) },
			{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ request: "later request" }) },
		]
		const updateClineMessage = vi.fn(async (index: number, updates: Partial<UiMessage>) => {
			messages[index] = { ...messages[index], ...updates }
		})
		const messageStateHandler = {
			get clineMessages() {
				return messages
			},
			updateClineMessage,
		} as unknown as MessageStateHandler
		const api = {
			getModel: () => ({ info: { pricing: { currency: "USD" } } }),
		} as unknown as ApiHandler

		await updateApiReqMsg({
			messageStateHandler,
			lastApiReqIndex: 0,
			inputTokens: 7,
			outputTokens: 2,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			contextTokens: 9,
			totalCost: 0,
			api,
		})

		expect(updateClineMessage).toHaveBeenCalledWith(0, expect.any(Object))
		expect(JSON.parse(messages[0].text ?? "{}")).toMatchObject({ request: "current request", tokensIn: 7 })
		expect(JSON.parse(messages[1].text ?? "{}")).toEqual({ request: "later request" })
	})

	it("replaces estimate provenance with reliable provider usage while preserving the sent estimate", async () => {
		const messages: UiMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					request: "estimated request",
					estimatedContextTokens: 42_000,
					contextTokensSource: "estimate",
				}),
			},
		]
		const updateClineMessage = vi.fn(async (index: number, updates: Partial<UiMessage>) => {
			messages[index] = { ...messages[index], ...updates }
		})
		const messageStateHandler = {
			get clineMessages() {
				return messages
			},
			updateClineMessage,
		} as unknown as MessageStateHandler
		const api = {
			getModel: () => ({ info: { pricing: { currency: "USD" } } }),
		} as unknown as ApiHandler

		await updateApiReqMsg({
			messageStateHandler,
			lastApiReqIndex: 0,
			inputTokens: 43_000,
			outputTokens: 2_000,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			contextTokens: 45_000,
			totalCost: 0,
			api,
		})

		expect(JSON.parse(messages[0].text ?? "{}")).toMatchObject({
			request: "estimated request",
			estimatedContextTokens: 42_000,
			contextTokens: 45_000,
			contextTokensSource: "provider",
		})
	})

	it("updates the current API request after earlier retry messages are removed", async () => {
		const messages: UiMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "Task" },
			{
				ts: 5,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ request: "retry feedback" }),
			},
		]
		const updateClineMessage = vi.fn(async (index: number, updates: Partial<UiMessage>) => {
			messages[index] = { ...messages[index], ...updates }
		})
		const messageStateHandler = {
			get clineMessages() {
				return messages
			},
			updateClineMessage,
		} as unknown as MessageStateHandler
		const api = {
			getModel: () => ({ info: { pricing: { currency: "USD" } } }),
		} as unknown as ApiHandler

		await updateApiReqMsg({
			messageStateHandler,
			lastApiReqIndex: 4,
			inputTokens: 10,
			outputTokens: 3,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			contextTokens: 13,
			totalCost: 0,
			api,
		})

		expect(updateClineMessage).toHaveBeenCalledTimes(1)
		expect(updateClineMessage).toHaveBeenCalledWith(1, expect.any(Object))
		expect(JSON.parse(messages[1].text ?? "{}")).toMatchObject({
			request: "retry feedback",
			contextTokens: 13,
			tokensIn: 10,
			tokensOut: 3,
			cost: 0,
		})
	})
})
