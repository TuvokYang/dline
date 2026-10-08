import {
	OpenAiCodexAuthStatus,
	OpenAiCodexBrowserOpenStatus,
	type OpenAiCodexCallbackUriRequest,
	OpenAiCodexFlowStatus,
	type OpenAiCodexOAuthJsonRequest,
	type OpenAiCodexProfileRequest,
	OpenAiCodexRateLimitResetOutcome,
} from "@shared/proto/dline/account"
import { ApiProfile } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cancelOpenAiCodexSignIn } from "./cancelOpenAiCodexSignIn"
import { completeOpenAiCodexCallbackUri } from "./completeOpenAiCodexCallbackUri"
import { consumeOpenAiCodexRateLimitResetCredit } from "./consumeOpenAiCodexRateLimitResetCredit"
import { getOpenAiCodexAuthStatus } from "./getOpenAiCodexAuthStatus"
import { getOpenAiCodexUsage } from "./getOpenAiCodexUsage"
import { importOpenAiCodexOAuthJson } from "./importOpenAiCodexOAuthJson"
import { signOutOpenAiCodexProfile } from "./signOutOpenAiCodexProfile"
import { startOpenAiCodexSignIn } from "./startOpenAiCodexSignIn"

const mocks = vi.hoisted(() => ({
	readApiProfilesFresh: vi.fn(),
	startAuthorizationFlow: vi.fn(),
	getAuthStatus: vi.fn(),
	getAccountIdentity: vi.fn(),
	getActiveAuthorizationFlow: vi.fn(),
	getLastAuthorizationFlowOutcome: vi.fn(),
	completeFromCallbackUri: vi.fn(),
	importCredentials: vi.fn(),
	cancelAuthorizationFlow: vi.fn(),
	clearCredentials: vi.fn(),
	getUsage: vi.fn(),
	consumeResetCredit: vi.fn(),
	loadProviderUsageSnapshot: vi.fn(),
	consumeProviderUsageResetCredit: vi.fn(),
	showMessage: vi.fn(),
	loggerError: vi.fn(),
}))

vi.mock("@/core/controller/file/getApiProfiles", () => ({ readApiProfilesFresh: mocks.readApiProfilesFresh }))
vi.mock("@/integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		startAuthorizationFlow: mocks.startAuthorizationFlow,
		getAuthStatus: mocks.getAuthStatus,
		getAccountIdentity: mocks.getAccountIdentity,
		getActiveAuthorizationFlow: mocks.getActiveAuthorizationFlow,
		getLastAuthorizationFlowOutcome: mocks.getLastAuthorizationFlowOutcome,
		completeFromCallbackUri: mocks.completeFromCallbackUri,
		importCredentials: mocks.importCredentials,
		cancelAuthorizationFlow: mocks.cancelAuthorizationFlow,
		clearCredentials: mocks.clearCredentials,
	},
}))
vi.mock("@/integrations/openai-codex/usage", () => ({
	openAiCodexUsageClient: {
		getUsage: mocks.getUsage,
		consumeRateLimitResetCredit: mocks.consumeResetCredit,
	},
}))
vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage: mocks.showMessage } } }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { error: mocks.loggerError } }))

const controller = {
	postStateToWebview: vi.fn(),
	loadProviderUsageSnapshot: mocks.loadProviderUsageSnapshot,
	consumeProviderUsageResetCredit: mocks.consumeProviderUsageResetCredit,
} as never
const profileA = ApiProfile.create({ id: "profile-a", name: "Codex A", provider: "openai-codex", enabled: true })
const profileB = ApiProfile.create({ id: "profile-b", name: "OpenAI B", provider: "openai", enabled: true })
const credentials = {
	access_token: "access-token",
	refresh_token: "refresh-token",
	expires: 1_900_000_000_000,
}

function profileRequest(profileId = profileA.id): OpenAiCodexProfileRequest {
	return { profileId }
}

describe("OpenAI Codex Profile OAuth handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.readApiProfilesFresh.mockResolvedValue([profileA, profileB])
		mocks.startAuthorizationFlow.mockResolvedValue({
			profileId: profileA.id,
			flowId: "flow-a",
			authorizationUrl: "https://auth.example.test/authorize?state=transient-state",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			expiresAtMs: 1_900_000_000_000,
			browserOpenStatus: "opened",
			result: new Promise(() => undefined),
		})
		mocks.getAuthStatus.mockResolvedValue("missing")
		mocks.getAccountIdentity.mockResolvedValue(null)
		mocks.getActiveAuthorizationFlow.mockReturnValue(undefined)
		mocks.getLastAuthorizationFlowOutcome.mockReturnValue(undefined)
		mocks.completeFromCallbackUri.mockResolvedValue(credentials)
		mocks.importCredentials.mockResolvedValue(credentials)
		mocks.cancelAuthorizationFlow.mockResolvedValue(undefined)
		mocks.clearCredentials.mockResolvedValue(undefined)
		mocks.getUsage.mockResolvedValue(undefined)
		mocks.consumeResetCredit.mockResolvedValue({ outcome: "reset", windowsReset: ["primary"] })
		mocks.loadProviderUsageSnapshot.mockResolvedValue({
			profileId: "profile-a",
			providerId: "openai-codex",
			currency: "",
			isAvailable: false,
		})
		mocks.consumeProviderUsageResetCredit.mockResolvedValue({
			result: { outcome: "reset", quotaTypesReset: ["primary"] },
			usage: {
				profileId: "profile-a",
				providerId: "openai-codex",
				currency: "",
				isAvailable: true,
			},
		})
	})

	it("starts an OAUTH flow for the explicit Profile and returns its transient presentation", async () => {
		await expect(startOpenAiCodexSignIn(controller, profileRequest())).resolves.toEqual({
			profileId: "profile-a",
			flowId: "flow-a",
			authorizationUrl: "https://auth.example.test/authorize?state=transient-state",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			expiresAtMs: 1_900_000_000_000,
			browserOpenStatus: OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_OPENED,
		})
		expect(mocks.startAuthorizationFlow).toHaveBeenCalledWith("profile-a")
	})

	it("rejects missing and non-Codex Profile targets before touching OAuth state", async () => {
		await expect(startOpenAiCodexSignIn(controller, profileRequest(""))).rejects.toThrow("OpenAI Codex Profile")
		await expect(startOpenAiCodexSignIn(controller, profileRequest("profile-b"))).rejects.toThrow("OpenAI Codex Profile")
		expect(mocks.startAuthorizationFlow).not.toHaveBeenCalled()
	})

	it("maps the Profile session status to a secret-free protobuf enum", async () => {
		mocks.getAuthStatus.mockResolvedValue("legacy-shared")
		mocks.getActiveAuthorizationFlow.mockReturnValue({
			profileId: "profile-a",
			flowId: "flow-a",
			authorizationUrl: "https://auth.example.test/authorize?state=transient-state",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			expiresAtMs: 1_900_000_000_000,
			browserOpenStatus: "failed",
		})
		mocks.getLastAuthorizationFlowOutcome.mockReturnValue({
			profileId: "profile-a",
			flowId: "previous-flow",
			status: "timed-out",
			endedAtMs: 1_800_000_000_000,
		})
		await expect(getOpenAiCodexAuthStatus(controller, profileRequest())).resolves.toEqual({
			profileId: "profile-a",
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_LEGACY_SHARED,
			flowId: "flow-a",
			activeFlow: {
				profileId: "profile-a",
				flowId: "flow-a",
				authorizationUrl: "https://auth.example.test/authorize?state=transient-state",
				redirectUri: "http://127.0.0.1:1455/auth/callback",
				expiresAtMs: 1_900_000_000_000,
				browserOpenStatus: OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_FAILED,
			},
			lastFlowOutcome: {
				profileId: "profile-a",
				flowId: "previous-flow",
				status: OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_TIMED_OUT,
				endedAtMs: 1_800_000_000_000,
			},
		})
	})

	it("returns the signed-in account name and email without credentials", async () => {
		mocks.getAuthStatus.mockResolvedValue("authenticated")
		mocks.getAccountIdentity.mockResolvedValue({
			accountId: "account-a",
			displayName: "Ada Lovelace",
			email: "ada@example.test",
			accountType: "pro",
			expiresAtMs: 1_900_000_000_000,
		})

		await expect(getOpenAiCodexAuthStatus(controller, profileRequest())).resolves.toMatchObject({
			profileId: "profile-a",
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
			account: {
				accountId: "account-a",
				displayName: "Ada Lovelace",
				email: "ada@example.test",
				accountType: "pro",
				expiresAtMs: 1_900_000_000_000,
			},
		})
	})

	it("returns Profile-scoped usage with plan, quota windows, and reset-card availability", async () => {
		mocks.loadProviderUsageSnapshot.mockResolvedValue({
			profileId: "profile-a",
			providerId: "openai-codex",
			currency: "USD",
			remainingBalance: 5,
			planType: "pro",
			allowed: true,
			limitReached: false,
			quotas: [
				{
					type: "5hour",
					label: "5 hour",
					used: 25,
					limit: 100,
					windowSeconds: 18_000,
					resetAt: new Date(1_800_000_000_000).toISOString(),
				},
			],
			resetCreditsAvailableCount: 1,
			resetCredits: [
				{
					id: "credit-a",
					grantedAt: new Date(1_800_000_000_000).toISOString(),
					expiresAt: new Date(1_900_000_000_000).toISOString(),
				},
			],
			isAvailable: true,
		})

		await expect(getOpenAiCodexUsage(controller, profileRequest())).resolves.toMatchObject({
			profileId: "profile-a",
			planType: "pro",
			isAvailable: true,
			resetCreditsAvailableCount: 1,
			resetCredits: [{ id: "credit-a", expiresAtMs: 1_900_000_000_000 }],
			windows: [{ type: "5hour", remainingPercent: 75 }],
		})
		expect(mocks.loadProviderUsageSnapshot).toHaveBeenCalledWith("profile-a")
	})

	it("consumes the selected reset credit only for the explicit Profile and maps the official outcome", async () => {
		mocks.consumeProviderUsageResetCredit.mockResolvedValue({
			result: { outcome: "reset", quotaTypesReset: ["primary"] },
			usage: {
				profileId: "profile-a",
				providerId: "openai-codex",
				currency: "",
				isAvailable: true,
			},
		})
		await expect(
			consumeOpenAiCodexRateLimitResetCredit(controller, { profileId: "profile-a", creditId: "credit-a" }),
		).resolves.toEqual({
			profileId: "profile-a",
			outcome: OpenAiCodexRateLimitResetOutcome.OPEN_AI_CODEX_RATE_LIMIT_RESET_OUTCOME_RESET,
			windowsReset: ["primary"],
		})
		expect(mocks.consumeProviderUsageResetCredit).toHaveBeenCalledWith("profile-a", "credit-a")
	})

	it("uses the same Profile and flow owner for callback completion and cancellation", async () => {
		const request: OpenAiCodexCallbackUriRequest = {
			profileId: "profile-a",
			flowId: "flow-a",
			callbackUri: "http://localhost:1455/auth/callback?code=secret-code&state=secret-state",
		}
		mocks.getAuthStatus.mockResolvedValue("authenticated")

		await expect(completeOpenAiCodexCallbackUri(controller, request)).resolves.toEqual({
			profileId: "profile-a",
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
			flowId: "",
		})
		expect(mocks.completeFromCallbackUri).toHaveBeenCalledWith(request)

		await cancelOpenAiCodexSignIn(controller, { profileId: "profile-a", flowId: "flow-a" })
		expect(mocks.cancelAuthorizationFlow).toHaveBeenCalledWith("profile-a", "flow-a")
	})

	it("imports OAuth JSON only for the explicit Profile and returns secret-free status", async () => {
		const request: OpenAiCodexOAuthJsonRequest = {
			profileId: "profile-a",
			oauthJson: JSON.stringify({
				type: "gpt-team",
				access_token: "manual-access",
				expires: 1_900_000_000_000,
				provider_private_claim: "private-value",
			}),
		}
		mocks.getAuthStatus.mockResolvedValue("authenticated")

		await expect(importOpenAiCodexOAuthJson(controller, request)).resolves.toEqual({
			profileId: "profile-a",
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
			flowId: "",
		})
		expect(mocks.importCredentials).toHaveBeenCalledWith("profile-a", JSON.parse(request.oauthJson))
	})

	it("does not expose OAuth JSON or provider payload through import errors or logs", async () => {
		const secret = "manual-secret-token"
		mocks.importCredentials.mockRejectedValue(new Error(secret))

		const error = await importOpenAiCodexOAuthJson(controller, {
			profileId: "profile-a",
			oauthJson: JSON.stringify({ access_token: secret, expires: 1_900_000_000_000 }),
		}).catch((caught: unknown) => caught)

		expect(String(error)).not.toContain(secret)
		expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(secret)
	})

	it("rejects malformed OAuth JSON before mutating the Profile credential", async () => {
		await expect(importOpenAiCodexOAuthJson(controller, { profileId: "profile-a", oauthJson: "{malformed" })).rejects.toThrow(
			"could not be imported",
		)
		expect(mocks.importCredentials).not.toHaveBeenCalled()
	})

	it("signs out only the explicit Codex Profile", async () => {
		await signOutOpenAiCodexProfile(controller, profileRequest())
		expect(mocks.clearCredentials).toHaveBeenCalledWith("profile-a")
	})

	it("reports a timed-out callback with an explicit secret-free message", async () => {
		const { OAuthFlowError } = await import("@/services/oauth")
		mocks.completeFromCallbackUri.mockRejectedValue(new OAuthFlowError("FLOW_TIMED_OUT", "provider-secret-detail", true))

		await expect(
			completeOpenAiCodexCallbackUri(controller, {
				profileId: "profile-a",
				flowId: "flow-a",
				callbackUri: "http://localhost:1455/auth/callback?code=secret-code&state=secret-state",
			}),
		).rejects.toThrow("OAUTH authentication timed out")
	})

	it("does not expose callback URI or provider payload through RPC errors or logs", async () => {
		const secret = "code=secret-code&state=secret-state&access_token=secret-token"
		mocks.completeFromCallbackUri.mockRejectedValue(new Error(secret))

		const error = await completeOpenAiCodexCallbackUri(controller, {
			profileId: "profile-a",
			flowId: "flow-a",
			callbackUri: `http://localhost:1455/auth/callback?${secret}`,
		}).catch((caught: unknown) => caught)

		expect(String(error)).not.toContain(secret)
		expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(secret)
	})
})
