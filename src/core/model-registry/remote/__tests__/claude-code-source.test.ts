import { describe, expect, it, vi } from "vitest"
import { CLAUDE_CODE_SDK_VERSION } from "@/integrations/anthropic-claude-code/client-headers"
import { mockFetchForTesting } from "@/shared/net"
import { ClaudeCodeModelSource } from "../vendors/claude-code"

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function listingPayload(modelId: string): unknown {
	return {
		data: [
			{
				type: "model",
				id: modelId,
				display_name: "Claude Listing Model",
				max_input_tokens: 400_000,
				max_tokens: 96_000,
				capabilities: {
					image_input: { supported: true },
					thinking: { supported: true },
					context_management: { prompt_caching: { supported: true } },
				},
			},
		],
		has_more: false,
	}
}

function sessionRegistryStub(overrides: { accessTokens?: string[]; refreshed?: string; failWith?: Error } = {}) {
	const tokens = [...(overrides.accessTokens ?? ["access-a"])]
	return {
		getAccessToken: vi.fn(async () => {
			if (overrides.failWith) throw overrides.failWith
			return tokens.shift() ?? "access-a"
		}),
		forceRefresh: vi.fn(async () => ({ access_token: overrides.refreshed ?? "access-refreshed" })),
	}
}

function versionSourceStub(version: string) {
	return { resolve: vi.fn(async () => ({ version })) }
}

describe("ClaudeCodeModelSource", () => {
	it("lists subscription models with the Claude Code OAuth wire identity", async () => {
		const registry = sessionRegistryStub()
		const requests: Array<{ url: string; headers: Headers }> = []
		const source = new ClaudeCodeModelSource(registry as never, versionSourceStub("2.1.280"))

		const models = await mockFetchForTesting(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({ url: String(input), headers: new Headers(init?.headers) })
				return jsonResponse(listingPayload("claude-opus-5-5"))
			},
			async () => source.fetchModels({ profileId: "profile-a" }),
		)

		expect(Object.keys(models)).toEqual(["claude-opus-5-5"])
		expect(models["claude-opus-5-5"].capabilities).toMatchObject({
			contextWindow: 400_000,
			maxTokens: 96_000,
			supportsImages: true,
			supportsReasoning: true,
			supportsPromptCache: true,
		})
		expect(requests).toHaveLength(1)
		expect(new URL(requests[0].url).pathname).toBe("/v1/models")
		// A subscription token is a bearer credential; `x-api-key` is rejected.
		expect(requests[0].headers.get("Authorization")).toBe("Bearer access-a")
		expect(requests[0].headers.get("x-api-key")).toBeNull()
		expect(requests[0].headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
		expect(requests[0].headers.get("anthropic-version")).toBe("2023-06-01")
		expect(requests[0].headers.get("User-Agent")).toBe("claude-cli/2.1.280 (external, cli)")
		expect(requests[0].headers.get("X-Stainless-Package-Version")).toBe(CLAUDE_CODE_SDK_VERSION)
	})

	it("does not send a listing request without a Profile identity", async () => {
		const registry = sessionRegistryStub()
		const versionSource = versionSourceStub("2.1.280")
		let calls = 0
		const source = new ClaudeCodeModelSource(registry as never, versionSource)

		const models = await mockFetchForTesting(
			async () => {
				calls++
				return jsonResponse(listingPayload("claude-opus-5-5"))
			},
			async () => source.fetchModels({}),
		)

		expect(models).toEqual({})
		expect(calls).toBe(0)
		expect(registry.getAccessToken).not.toHaveBeenCalled()
		expect(versionSource.resolve).not.toHaveBeenCalled()
	})

	it("returns an empty catalog when the Profile is signed out", async () => {
		const registry = sessionRegistryStub({ failWith: new Error("This profile is not signed in to Claude Code.") })
		let calls = 0
		const source = new ClaudeCodeModelSource(registry as never, versionSourceStub("2.1.280"))

		const models = await mockFetchForTesting(
			async () => {
				calls++
				return jsonResponse(listingPayload("claude-opus-5-5"))
			},
			async () => source.fetchModels({ profileId: "profile-a" }),
		)

		expect(models).toEqual({})
		expect(calls).toBe(0)
	})

	it("refreshes the credential once after a 401 and retries the listing", async () => {
		const registry = sessionRegistryStub({ refreshed: "access-b" })
		const authorizations: string[] = []
		const source = new ClaudeCodeModelSource(registry as never, versionSourceStub("2.1.280"))

		const models = await mockFetchForTesting(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				authorizations.push(new Headers(init?.headers).get("Authorization") ?? "")
				return authorizations.length === 1
					? jsonResponse({ error: { type: "authentication_error" } }, 401)
					: jsonResponse(listingPayload("claude-sonnet-4-5-20250929"))
			},
			async () => source.fetchModels({ profileId: "profile-a" }),
		)

		expect(registry.forceRefresh).toHaveBeenCalledWith("profile-a")
		expect(authorizations).toEqual(["Bearer access-a", "Bearer access-b"])
		expect(Object.keys(models)).toEqual(["claude-sonnet-4-5-20250929"])
	})

	it("propagates a non-authentication failure instead of hiding it as an empty catalog", async () => {
		const registry = sessionRegistryStub()
		const source = new ClaudeCodeModelSource(registry as never, versionSourceStub("2.1.280"))

		await expect(
			mockFetchForTesting(
				async () => jsonResponse({ error: { type: "overloaded_error" } }, 529),
				async () => source.fetchModels({ profileId: "profile-a" }),
			),
		).rejects.toThrow(/status 529/)
		expect(registry.forceRefresh).not.toHaveBeenCalled()
	})
})
