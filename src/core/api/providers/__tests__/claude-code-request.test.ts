import { ClaudeCodeHandler } from "@core/api/providers/claude-code"
import { DISABLED_WEB_SEARCH_ROUTING_PLAN } from "@core/prompts/__tests__/web-search-routing-fixtures"
import { ToolPromptGenerator } from "@core/prompts/generators/ToolPromptGenerator"
import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt/context"
import { ApiProfile } from "@shared/proto/dline/profile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CLAUDE_CODE_SDK_VERSION } from "@/integrations/anthropic-claude-code/client-headers"

/**
 * Request-shape regressions for the subscription provider.
 *
 * These assert the body that actually reaches the Messages API. Model
 * resolution alone cannot catch a CLI-era selector or a missing cache
 * breakpoint, because both are still well-formed TypeScript.
 */

const created = vi.fn()
const constructed = vi.fn()
/** Namespace the request was sent through: the beta one uses `?beta=true`. */
const usedNamespace = vi.fn()
/** Statuses the SDK rejects with, one per call, before succeeding. */
let rejections: Array<number | undefined> = []

/** A rejection shaped like the SDK's own HTTP error, which carries `status`. */
function sdkError(status: number): Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status}`), { status })
}

vi.mock("@anthropic-ai/sdk", () => {
	const emptyStream = () =>
		Promise.resolve(
			(async function* () {
				/* no events: these tests only inspect the request */
			})(),
		)
	const respond = (namespace: string, args: unknown[]) => {
		usedNamespace(namespace)
		created(...args)
		const status = rejections.shift()
		return status === undefined ? emptyStream() : Promise.reject(sdkError(status))
	}
	return {
		Anthropic: class {
			constructor(options: unknown) {
				constructed(options)
			}
			messages = { create: (...args: unknown[]) => respond("messages", args) }
			beta = { messages: { create: (...args: unknown[]) => respond("beta.messages", args) } }
		},
	}
})

/** Tokens the session registry hands out, in order, across a test. */
let accessTokens: string[] = ["test-access-token"]
const forcedRefreshes = vi.fn()

vi.mock("@/integrations/anthropic-claude-code/registry", () => ({
	getClaudeCodeProfileSessionRegistry: () => ({
		getAccessToken: () => Promise.resolve(accessTokens.length > 1 ? accessTokens.shift()! : accessTokens[0]),
		forceRefresh: (profileId: string) => {
			forcedRefreshes(profileId)
			// A real refresh replaces the stored credential, so the next
			// resolution observes the rotated token.
			if (accessTokens.length > 1) accessTokens.shift()
			return Promise.resolve({ access_token: accessTokens[0] })
		},
	}),
}))

/** Version the identity resolver reports; empty means it could not resolve one. */
let clientVersion = "1.2.3"

vi.mock("../../../model-registry/remote/vendors/claude-code-client-version", () => ({
	getClaudeCodeClientVersionResolver: () => ({ resolve: () => Promise.resolve({ version: clientVersion }) }),
}))

/**
 * A model outside the bundled catalog whose Profile carries budget-thinking
 * metadata. Every offered model uses adaptive thinking, so the budget request
 * shape is only reachable through Profile-carried metadata.
 */
const BUDGET_MODEL_ID = "claude-budget-thinking-test"
const BUDGET_MODEL_INFO = {
	id: BUDGET_MODEL_ID,
	capabilities: {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsTools: true,
		supportsForcedToolUse: true,
	},
}

function createHandler(modelId: string, thinkingBudget = 0): ClaudeCodeHandler {
	return new ClaudeCodeHandler({
		profile: ApiProfile.create({
			provider: "claude-code",
			modelId,
			...(modelId === BUDGET_MODEL_ID ? { modelInfo: BUDGET_MODEL_INFO as never } : {}),
			claudeCode: thinkingBudget > 0 ? { reasoning: { thinkingBudget, enableThinking: true } } : {},
		}),
		mode: "act",
	})
}

async function drain(handler: ClaudeCodeHandler): Promise<Record<string, any>> {
	const stream = handler.createMessage("system prompt", [{ role: "user", content: "hi" }])
	for await (const _ of stream) {
		/* drain */
	}
	return created.mock.calls.at(-1)?.[0] as Record<string, any>
}

async function sendRequest(modelId: string, thinkingBudget = 0): Promise<Record<string, any>> {
	return drain(createHandler(modelId, thinkingBudget))
}

/** Send one request carrying the tools the prompt pipeline really projects. */
async function sendRequestWithProjectedTools(modelId: string): Promise<Record<string, any>> {
	const projected = new ToolPromptGenerator().generate(PromptProfile.Standard, {
		promptProfile: PromptProfile.Standard,
		providerInfo: { providerId: "claude-code", model: { id: modelId, info: {} } },
		enableNativeToolCalls: true,
		webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN,
		terminalCommandTimeoutSeconds: 1800,
	} as unknown as SystemPromptContext)
	const stream = createHandler(modelId).createMessage("system prompt", [{ role: "user", content: "hi" }], projected as never)
	for await (const _ of stream) {
		/* drain */
	}
	return created.mock.calls.at(-1)?.[0] as Record<string, any>
}

/** Bearer tokens seen by the SDK, whether set at construction or per request. */
function observedAuthTokens(): string[] {
	return created.mock.calls.map((call, index) => {
		const perRequest = (call[1] as { headers?: Record<string, string> } | undefined)?.headers?.Authorization
		if (typeof perRequest === "string") return perRequest.replace(/^Bearer /, "")
		return (constructed.mock.calls[index]?.[0] as { authToken?: string } | undefined)?.authToken ?? ""
	})
}

function lastHeaders(): Record<string, string> {
	return (created.mock.calls.at(-1)?.[1] as { headers: Record<string, string> }).headers
}

/**
 * The beta set the request declares, rendered as the header value would be.
 *
 * The SDK's beta namespace turns the `betas` parameter into `anthropic-beta`,
 * so the parameter is where the declaration is observable before transport.
 */
function declaredBetas(body: Record<string, any>): string {
	return (body.betas as string[] | undefined)?.join(",") ?? ""
}

describe("ClaudeCodeHandler credential freshness", () => {
	beforeEach(() => {
		created.mockClear()
		constructed.mockClear()
		forcedRefreshes.mockClear()
		rejections = []
		accessTokens = ["test-access-token"]
	})

	// The registry refreshes an expired token between turns. A client that
	// captured the token at construction keeps sending the stale one until the
	// handler is rebuilt, which fails every request for the rest of the task.
	it("sends the current token after the registry rotates it", async () => {
		accessTokens = ["first-token", "second-token"]
		const handler = createHandler(BUDGET_MODEL_ID)

		await drain(handler)
		await drain(handler)

		expect(observedAuthTokens()).toEqual(["first-token", "second-token"])
	})

	it("reuses the client while the token is unchanged", async () => {
		const handler = createHandler(BUDGET_MODEL_ID)

		await drain(handler)
		await drain(handler)

		expect(constructed).toHaveBeenCalledTimes(1)
	})

	// Expiry is predicted from the stored lifetime, so a token revoked early
	// still looks valid. Upstream answers 401, and without an explicit refresh
	// the Profile stays broken until the user signs in again by hand.
	it("refreshes and retries once when upstream rejects the token", async () => {
		accessTokens = ["revoked-token", "renewed-token"]
		rejections = [401]

		const body = await drain(createHandler(BUDGET_MODEL_ID))

		expect(forcedRefreshes).toHaveBeenCalledTimes(1)
		expect(observedAuthTokens()).toEqual(["revoked-token", "renewed-token"])
		expect(body.model).toBe(BUDGET_MODEL_ID)
	})

	// A second 401 means the fresh credential is rejected too, so retrying
	// again would only spend the refresh token against a decided answer.
	it("surfaces the failure when the refreshed token is rejected as well", async () => {
		accessTokens = ["revoked-token", "renewed-token"]
		rejections = [401, 401]

		await expect(drain(createHandler(BUDGET_MODEL_ID))).rejects.toMatchObject({ status: 401 })
		expect(forcedRefreshes).toHaveBeenCalledTimes(1)
	})

	// 403 is an authorization decision about the account, not a stale token;
	// refreshing cannot change it and would hide the real reason.
	it("does not refresh for a non-authentication failure", async () => {
		rejections = [403]

		await expect(drain(createHandler(BUDGET_MODEL_ID))).rejects.toMatchObject({ status: 403 })
		expect(forcedRefreshes).not.toHaveBeenCalled()
	})
})

describe("ClaudeCodeHandler client identity", () => {
	beforeEach(() => {
		created.mockClear()
		rejections = []
		clientVersion = "1.2.3"
		accessTokens = ["test-access-token"]
	})

	afterEach(() => {
		clientVersion = "1.2.3"
	})

	// The subscription token is only accepted from a caller presenting the
	// Claude Code identity. Sending the request without it produces a remote
	// 401 that blames the credential, hiding the local resolution failure.
	it("does not send a request whose client identity could not be built", async () => {
		clientVersion = ""

		await expect(drain(createHandler(BUDGET_MODEL_ID))).rejects.toThrow(/client identity/i)
		expect(created).not.toHaveBeenCalled()
	})
})

describe("ClaudeCodeHandler request body", () => {
	beforeEach(() => {
		created.mockClear()
		constructed.mockClear()
		forcedRefreshes.mockClear()
		rejections = []
		accessTokens = ["test-access-token"]
	})

	it("sends the selected model unchanged", async () => {
		expect((await sendRequest("claude-opus-5")).model).toBe("claude-opus-5")
	})

	// The handler forwards the projected tools verbatim, so a request built from
	// the real prompt pipeline is the only place the wire shape is observable.
	// The Messages API validates each tool by its `type` tag and rejects the
	// OpenAI function wrapper with `Input tag 'function' ... does not match`.
	it("sends tools in the Anthropic input-schema shape", async () => {
		const body = await sendRequestWithProjectedTools(BUDGET_MODEL_ID)
		const tools = body.tools as Array<Record<string, unknown>>

		expect(tools.length).toBeGreaterThan(0)
		for (const tool of tools) {
			expect(tool).not.toHaveProperty("function")
			expect(tool.type).not.toBe("function")
			expect(tool).toHaveProperty("input_schema")
			expect(typeof tool.name).toBe("string")
		}
	})

	// Adaptive-thinking models reject a forced tool choice outright:
	// `tool_choice: type "tool" and "any" are not supported for this model`.
	// Thinking is effectively always on for them, and thinking cannot be
	// combined with forced tool use, so the whole generation fails rather than
	// degrading to an automatic choice.
	it("never forces a tool choice on an adaptive-thinking model", async () => {
		const body = await sendRequestWithProjectedTools("claude-opus-5")

		expect(body.tool_choice).toEqual({ type: "auto" })
	})

	// Budget-mode models still accept forcing, and giving that up would let the
	// model answer in prose where a tool call is required.
	it("still forces a tool choice on a budget-thinking model", async () => {
		const body = await sendRequestWithProjectedTools(BUDGET_MODEL_ID)

		expect(body.tool_choice).toEqual({ type: "any" })
	})

	// A subscription cannot buy the metered 1M window, so the request must never
	// ask for it; doing so is rejected rather than billed.
	it("never requests the long-context beta", async () => {
		const body = await sendRequest("claude-opus-5")

		expect(declaredBetas(body)).not.toContain("context-1m")
	})

	// The OAuth beta is what authorizes a subscription token for inference.
	it("always declares the subscription OAuth beta", async () => {
		const body = await sendRequest(BUDGET_MODEL_ID)

		expect(declaredBetas(body)).toContain("oauth-2025-04-20")
	})

	// Upstream classifies the caller by the *whole* beta set, not one header.
	// Missing a value the real client always sends bills the request against
	// third-party usage instead of the subscription, so the set is fixed and
	// ordered rather than assembled from the capabilities a request happens to
	// use. Order follows real client traffic.
	const mimicryBetas = [
		"claude-code-20250219",
		"oauth-2025-04-20",
		"interleaved-thinking-2025-05-14",
		"prompt-caching-scope-2026-01-05",
		"effort-2025-11-24",
		"context-management-2025-06-27",
		"thinking-binding-controls-2026-08-01",
		"mid-conversation-output-config-2026-07-01",
		"extended-cache-ttl-2025-04-11",
	].join(",")

	it("declares the full client beta set when reasoning is off", async () => {
		const body = await sendRequest(BUDGET_MODEL_ID)

		expect(declaredBetas(body)).toBe(mimicryBetas)
	})

	it("declares the same beta set when reasoning is on", async () => {
		const body = await sendRequest(BUDGET_MODEL_ID, 2048)

		expect(declaredBetas(body)).toBe(mimicryBetas)
	})

	// Declaring this one by default would let upstream strip thinking content.
	it("never declares the redact-thinking beta", async () => {
		const body = await sendRequest("claude-opus-5")

		expect(declaredBetas(body)).not.toContain("redact-thinking")
	})

	// Several declared betas are beta-API features, and the SDK only reaches
	// `/v1/messages?beta=true` through the beta namespace. Declaring them on the
	// stable route asks for capabilities that route does not serve.
	it("sends through the beta messages route", async () => {
		await sendRequest(BUDGET_MODEL_ID)

		expect(usedNamespace).toHaveBeenLastCalledWith("beta.messages")
	})

	// The catalog now declares prompt caching, so the request must actually set
	// a breakpoint; otherwise the capability is advertised but never used.
	it("sets a cache breakpoint on the system prompt", async () => {
		const system = (await sendRequest(BUDGET_MODEL_ID)).system

		expect(system.at(-1)).toMatchObject({
			text: "system prompt",
			cache_control: { type: "ephemeral" },
		})
	})

	// The attribution block leads the system array and carries no cache_control
	// of its own, matching real client traffic.
	it("keeps the attribution block ahead of the system prompt", async () => {
		const system = (await sendRequest(BUDGET_MODEL_ID)).system

		expect(system.length).toBeGreaterThan(1)
		expect(system[0].cache_control).toBeUndefined()
	})

	// Unlike the anthropic provider, where attribution is opt-in, a subscription
	// token is only accepted from something presenting itself as Claude Code, so
	// the block must be declared without any configuration.
	it("declares the billing attribution block unconditionally", async () => {
		const system = (await sendRequest(BUDGET_MODEL_ID)).system

		expect(system[0].text).toContain("cc_version=1.2.3")
	})

	// Upstream reads the User-Agent and the attribution block as one identity and
	// checks the User-Agent first, so sending the block without the headers is a
	// weaker claim than sending neither.
	it("declares the client identity headers alongside the block", async () => {
		const system = (await sendRequest(BUDGET_MODEL_ID)).system
		const headers = lastHeaders()

		expect(headers["User-Agent"]).toBe("claude-cli/1.2.3 (external, cli)")
		expect(headers["X-Stainless-Package-Version"]).toBe(CLAUDE_CODE_SDK_VERSION)
		// One resolution feeds both; a mismatch is itself a third-party signal.
		const declared = /^claude-cli\/(\d+\.\d+\.\d+) /.exec(headers["User-Agent"])?.[1]
		expect(system[0].text).toContain(`cc_version=${declared}.`)
	})

	// Adaptive models reject an explicit token budget and reject temperature.
	it("asks an adaptive model for effort rather than a token budget", async () => {
		const body = await sendRequest("claude-opus-5", 8192)

		expect(body.thinking).toMatchObject({ type: "adaptive" })
		expect(body.thinking.budget_tokens).toBeUndefined()
		expect(body.temperature).toBeUndefined()
	})

	// A model without adaptive thinking still uses the budget form.
	it("sends a token budget for a non-adaptive model", async () => {
		const body = await sendRequest(BUDGET_MODEL_ID, 8192)

		expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 8192 })
	})

	it("pins temperature when no reasoning is requested", async () => {
		expect((await sendRequest(BUDGET_MODEL_ID)).temperature).toBe(0)
	})
})
