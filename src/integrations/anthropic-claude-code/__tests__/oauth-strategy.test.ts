import { describe, expect, it, vi } from "vitest"
import {
	CLAUDE_CODE_OAUTH_CONFIG,
	ClaudeCodeOAuthStrategy,
	ClaudeCodeOAuthTokenError,
	isClaudeCodeCredentialExpired,
} from "../oauth-strategy"

const NOW = 1_800_000_000_000
const LOOPBACK_REDIRECT_URI = "http://localhost:54545/callback"

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status })
}

function createStrategy(fetchImpl: ReturnType<typeof vi.fn>): ClaudeCodeOAuthStrategy {
	return new ClaudeCodeOAuthStrategy({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })
}

describe("ClaudeCodeOAuthStrategy authorization URL", () => {
	it("omits the hosted-page marker and keeps `+` scope separators for a loopback redirect", () => {
		const strategy = createStrategy(vi.fn())

		const url = strategy.buildAuthorizationUrl({
			redirectUri: LOOPBACK_REDIRECT_URI,
			codeChallenge: "challenge",
			state: "state-a",
		})

		expect(url.origin + url.pathname).toBe(CLAUDE_CODE_OAUTH_CONFIG.authorizationEndpoint)
		expect(url.searchParams.get("code")).toBeNull()
		expect(url.searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI)
		expect(url.searchParams.get("client_id")).toBe(CLAUDE_CODE_OAUTH_CONFIG.clientId)
		expect(url.searchParams.get("code_challenge_method")).toBe("S256")
		expect(url.searchParams.get("state")).toBe("state-a")
		// Percent-encoded spaces are rejected by this endpoint, so the raw query
		// must keep `+` even though URLSearchParams would have escaped them.
		expect(url.search).toContain("scope=org%3Acreate_api_key+user%3Aprofile")
		expect(url.searchParams.get("scope")).toBe(CLAUDE_CODE_OAUTH_CONFIG.scopes)
	})

	it("prefixes the hosted-page marker for the manual redirect", () => {
		const strategy = createStrategy(vi.fn())

		const url = strategy.buildAuthorizationUrl({
			redirectUri: CLAUDE_CODE_OAUTH_CONFIG.manualRedirectUri,
			codeChallenge: "challenge",
			state: "state-a",
		})

		expect(url.search.startsWith("?code=true&")).toBe(true)
		expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_CODE_OAUTH_CONFIG.manualRedirectUri)
		expect(url.searchParams.get("state")).toBe("state-a")
	})

	// The authorization page is served to a real client fingerprint, and the
	// observed client emits these parameters in a fixed order. Reordering them
	// is a visible difference even though the query is semantically identical.
	it.each([
		LOOPBACK_REDIRECT_URI,
		CLAUDE_CODE_OAUTH_CONFIG.manualRedirectUri,
	])("emits the client parameter order for %s", (redirectUri) => {
		const strategy = createStrategy(vi.fn())

		const url = strategy.buildAuthorizationUrl({ redirectUri, codeChallenge: "challenge", state: "state-a" })

		const names = [...new URLSearchParams(url.search).keys()].filter((name) => name !== "code")
		expect(names).toEqual([
			"client_id",
			"response_type",
			"redirect_uri",
			"scope",
			"code_challenge",
			"code_challenge_method",
			"state",
		])
	})

	it("advertises both completion paths to the shared flow coordinator", () => {
		const strategy = createStrategy(vi.fn())

		expect(strategy.manualRedirectUri).toBe(CLAUDE_CODE_OAUTH_CONFIG.manualRedirectUri)
		expect(strategy.callbackPorts.length).toBeGreaterThan(1)
		expect(strategy.callbackRedirectHost).toBe("localhost")
	})
})

describe("ClaudeCodeOAuthStrategy manual code", () => {
	it("splits the hosted `code#state` string", () => {
		const strategy = createStrategy(vi.fn())

		expect(strategy.parseManualCode("auth-code-a#state-a")).toEqual({ code: "auth-code-a", state: "state-a" })
	})

	it("accepts a bare code when the user copied only the leading segment", () => {
		const strategy = createStrategy(vi.fn())

		expect(strategy.parseManualCode("  auth-code-a  ")).toEqual({ code: "auth-code-a" })
	})

	it("rejects a paste with no code", () => {
		const strategy = createStrategy(vi.fn())

		expect(() => strategy.parseManualCode("#state-a")).toThrowError(ClaudeCodeOAuthTokenError)
	})
})

describe("ClaudeCodeOAuthStrategy token requests", () => {
	it("exchanges an authorization code as JSON and stores the account identity", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				access_token: "access-a",
				refresh_token: "refresh-a",
				expires_in: 3600,
				scope: "user:inference",
				account: { uuid: "account-a", email_address: "user@example.test", display_name: "User A" },
				organization: { name: "Org A" },
			}),
		)
		const strategy = createStrategy(fetchImpl)

		await expect(
			strategy.exchangeAuthorizationCode({
				code: "auth-code-a",
				codeVerifier: "verifier",
				redirectUri: LOOPBACK_REDIRECT_URI,
			}),
		).resolves.toEqual({
			type: "claude-code",
			access_token: "access-a",
			refresh_token: "refresh-a",
			expires: NOW + 3_600_000,
			scopes: "user:inference",
			accountId: "account-a",
			email: "user@example.test",
			displayName: "User A",
			organizationName: "Org A",
		})

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(CLAUDE_CODE_OAUTH_CONFIG.tokenEndpoint)
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
		expect(JSON.parse(String(init.body))).toMatchObject({
			grant_type: "authorization_code",
			code: "auth-code-a",
			code_verifier: "verifier",
			redirect_uri: LOOPBACK_REDIRECT_URI,
		})
	})

	it("echoes the hosted redirect URI when the code came from the pasted path", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "access-a", expires_in: 3600 }))
		const strategy = createStrategy(fetchImpl)

		await strategy.exchangeAuthorizationCode({
			code: "auth-code-a",
			codeVerifier: "verifier",
			redirectUri: CLAUDE_CODE_OAUTH_CONFIG.manualRedirectUri,
		})

		expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).redirect_uri).toBe(
			CLAUDE_CODE_OAUTH_CONFIG.manualRedirectUri,
		)
	})

	// This endpoint requires the state back whenever the authorization issued
	// one, so both completion paths have to return it. Omitting it on the
	// loopback path is what made a successful browser authorization fail.
	it.each([
		["the hosted paste", CLAUDE_CODE_OAUTH_CONFIG.manualRedirectUri],
		["the loopback callback", LOOPBACK_REDIRECT_URI],
	])("returns the state from %s to the token endpoint", async (_label, redirectUri) => {
		const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "access-a", expires_in: 3600 }))
		const strategy = createStrategy(fetchImpl)

		await strategy.exchangeAuthorizationCode({
			code: "auth-code-a",
			codeVerifier: "verifier",
			redirectUri,
			callbackParams: { code: "auth-code-a", state: "state-a" },
		})

		expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).state).toBe("state-a")
	})

	// A bare code copied without its trailing fragment carries no state, and
	// sending an empty field would not match the authorization request.
	it("omits state when the authorization returned none", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "access-a", expires_in: 3600 }))
		const strategy = createStrategy(fetchImpl)

		await strategy.exchangeAuthorizationCode({
			code: "auth-code-a",
			codeVerifier: "verifier",
			redirectUri: LOOPBACK_REDIRECT_URI,
		})

		expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty(
			"state",
		)
	})

	it("keeps the previous refresh token and identity when the refresh response omits them", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "access-b", expires_in: 3600 }))
		const strategy = createStrategy(fetchImpl)

		await expect(
			strategy.refreshCredential({
				type: "claude-code",
				access_token: "access-a",
				refresh_token: "refresh-a",
				expires: NOW,
				email: "user@example.test",
			}),
		).resolves.toMatchObject({
			access_token: "access-b",
			refresh_token: "refresh-a",
			expires: NOW + 3_600_000,
			email: "user@example.test",
		})
	})

	it("refuses to refresh a credential that has no refresh token", async () => {
		const fetchImpl = vi.fn()
		const strategy = createStrategy(fetchImpl)

		await expect(
			strategy.refreshCredential({ type: "claude-code", access_token: "access-a", expires: NOW }),
		).rejects.toMatchObject({ code: "REFRESH_TOKEN_UNAVAILABLE" })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("classifies an invalid grant without leaking the provider response body", async () => {
		const secretPayload = "invalid_grant provider-refresh-token-must-not-leak"
		const strategy = createStrategy(vi.fn(async () => new Response(secretPayload, { status: 400 })))

		const error = await strategy
			.refreshCredential({ type: "claude-code", access_token: "access-a", refresh_token: "refresh-a", expires: NOW })
			.catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(ClaudeCodeOAuthTokenError)
		expect(error).toMatchObject({ code: "INVALID_GRANT", status: 400 })
		expect((error as Error).message).not.toContain("provider-refresh-token-must-not-leak")
	})

	it("rejects a token response without a usable expiry", async () => {
		const strategy = createStrategy(vi.fn(async () => jsonResponse({ access_token: "access-a" })))

		await expect(
			strategy.exchangeAuthorizationCode({ code: "a", codeVerifier: "v", redirectUri: LOOPBACK_REDIRECT_URI }),
		).rejects.toMatchObject({ code: "INVALID_TOKEN_RESPONSE" })
	})
})

describe("ClaudeCodeOAuthStrategy presentation and expiry", () => {
	it("exposes only derived labels on the callback page", () => {
		const strategy = createStrategy(vi.fn())

		const presentation = strategy.describeAccount({
			type: "claude-code",
			access_token: "secret-access-token",
			refresh_token: "secret-refresh-token",
			expires: NOW,
			displayName: "User A",
			email: "user@example.test",
			organizationName: "Org A",
		})

		expect(presentation).toEqual({
			providerName: "Claude Code",
			accountName: "User A",
			accountDetail: "user@example.test",
			planName: "Org A",
		})
		expect(JSON.stringify(presentation)).not.toContain("secret-")
	})

	it("treats a credential inside the refresh buffer as expired", () => {
		const credential = { type: "claude-code", access_token: "access-a", expires: NOW }

		expect(isClaudeCodeCredentialExpired(credential, NOW - 10 * 60_000)).toBe(false)
		expect(isClaudeCodeCredentialExpired(credential, NOW - 60_000)).toBe(true)
		expect(isClaudeCodeCredentialExpired(credential, NOW)).toBe(true)
	})
})
