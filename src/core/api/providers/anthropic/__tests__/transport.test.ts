import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"
import { buildClaudeCodeBetas } from "@/integrations/anthropic-claude-code/beta-headers"
import type { AnthropicMessagesRequestBody } from "../request-builder"
import { ANTHROPIC_FAST_MODE_BETA, ApiKeyAnthropicTransport, ClaudeCodeSubscriptionTransport } from "../transport"

const body = {
	model: "claude-test",
	max_tokens: 1_024,
	messages: [{ role: "user", content: "hi" }],
	stream: true,
} as AnthropicMessagesRequestBody
const stream = { async *[Symbol.asyncIterator]() {} }

function fakeClient() {
	const create = vi.fn().mockResolvedValue(stream)
	const betaCreate = vi.fn().mockResolvedValue(stream)
	const client = { messages: { create }, beta: { messages: { create: betaCreate } } } as unknown as Anthropic
	return { client, create, betaCreate }
}

function httpError(status: number): Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe("ApiKeyAnthropicTransport", () => {
	it("posts to the stable route with per-request headers only when there are any", async () => {
		const { client, create, betaCreate } = fakeClient()
		const transport = new ApiKeyAnthropicTransport(client, false)

		await transport.open(body, { "user-agent": "claude-cli/1.0.0" })
		await transport.open(body, {})

		expect(create.mock.calls).toEqual([
			[body, { headers: { "user-agent": "claude-cli/1.0.0" } }],
			[body, undefined],
		])
		expect(betaCreate).not.toHaveBeenCalled()
	})

	it("routes fast mode through the beta endpoint with the same identity headers as the stable route", async () => {
		const { client, create, betaCreate } = fakeClient()
		const transport = new ApiKeyAnthropicTransport(client, true)

		await transport.open(body, { "user-agent": "claude-cli/1.0.0" })
		await transport.open(body, {})

		const fastBody = { ...body, betas: [ANTHROPIC_FAST_MODE_BETA], speed: "fast" }
		expect(betaCreate.mock.calls).toEqual([
			[fastBody, { headers: { "user-agent": "claude-cli/1.0.0" } }],
			[fastBody, undefined],
		])
		expect(create).not.toHaveBeenCalled()
	})
})

describe("ClaudeCodeSubscriptionTransport", () => {
	const headers = { "user-agent": "claude-cli/1.0.0" }

	it("posts every request to the beta route with the Claude Code betas and identity headers", async () => {
		const { client, betaCreate } = fakeClient()
		const renewClient = vi.fn()

		await new ClaudeCodeSubscriptionTransport(client, renewClient).open(body, headers)

		expect(betaCreate).toHaveBeenCalledWith({ ...body, betas: buildClaudeCodeBetas() }, { headers })
		expect(renewClient).not.toHaveBeenCalled()
	})

	it("renews the credential once on 401 and keeps the renewed client for continuations", async () => {
		const rejected = fakeClient()
		rejected.betaCreate.mockRejectedValueOnce(httpError(401))
		const renewed = fakeClient()
		const renewClient = vi.fn().mockResolvedValue(renewed.client)
		const transport = new ClaudeCodeSubscriptionTransport(rejected.client, renewClient)

		await transport.open(body, headers)
		await transport.open({ ...body, messages: [] }, headers)

		expect(renewClient).toHaveBeenCalledTimes(1)
		expect(rejected.betaCreate).toHaveBeenCalledTimes(1)
		expect(renewed.betaCreate).toHaveBeenCalledTimes(2)
	})

	it("does not refresh for a 403 and surfaces it unchanged", async () => {
		const { client, betaCreate } = fakeClient()
		const forbidden = httpError(403)
		betaCreate.mockRejectedValueOnce(forbidden)
		const renewClient = vi.fn()

		await expect(new ClaudeCodeSubscriptionTransport(client, renewClient).open(body, headers)).rejects.toBe(forbidden)
		expect(renewClient).not.toHaveBeenCalled()
	})

	it("surfaces a second 401 after one renewal instead of refreshing again", async () => {
		const rejected = fakeClient()
		rejected.betaCreate.mockRejectedValueOnce(httpError(401))
		const stillRejected = fakeClient()
		const secondFailure = httpError(401)
		stillRejected.betaCreate.mockRejectedValueOnce(secondFailure)
		const renewClient = vi.fn().mockResolvedValue(stillRejected.client)

		await expect(new ClaudeCodeSubscriptionTransport(rejected.client, renewClient).open(body, headers)).rejects.toBe(
			secondFailure,
		)
		expect(renewClient).toHaveBeenCalledTimes(1)
	})
})
