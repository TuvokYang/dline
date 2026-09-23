import type { ClaudeCodeOAuthCredentials } from "@/core/storage/secrets/ClaudeCodeProfileAuthRepository"
import { parseClaudeCodeOAuthCredentials } from "@/core/storage/secrets/ClaudeCodeProfileAuthRepository"
import type {
	OAuthAccountPresentation,
	OAuthAuthorizationInput,
	OAuthAuthorizationStrategy,
	OAuthCodeExchangeInput,
	ParsedManualOAuthCode,
} from "@/services/oauth"
import { fetch } from "@/shared/net"
import { resolveClaudeCodeRuntimeConfig } from "./runtime-config"

/**
 * Authorization parameters mirror the current Claude Code subscription login.
 *
 * Anthropic accepts two callback shapes for the same client. A loopback
 * `redirect_uri` returns the code as a query parameter, while appending
 * `code=true` switches the provider to a hosted page that shows the user a
 * `code#state` string to copy. Both are offered so a blocked loopback port
 * still leaves a usable sign-in path.
 *
 * Endpoints come from the runtime config so an E2E run can point the flow at a
 * loopback mock; every other value is a property of the client itself.
 */
export const CLAUDE_CODE_OAUTH_CONFIG = {
	...(() => {
		const runtime = resolveClaudeCodeRuntimeConfig()
		return {
			authorizationEndpoint: runtime.authorizationEndpoint,
			tokenEndpoint: runtime.tokenEndpoint,
			manualRedirectUri: runtime.manualRedirectUri,
			callbackPorts: (runtime.callbackPorts ?? [54545, 54546, 54547]) as readonly number[],
		}
	})(),
	clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
	callbackPort: 54545,
	callbackRedirectHost: "localhost",
	callbackPath: "/callback",
} as const

export type ClaudeCodeOAuthTokenErrorCode =
	| "TOKEN_EXCHANGE_FAILED"
	| "TOKEN_REFRESH_FAILED"
	| "REFRESH_TOKEN_UNAVAILABLE"
	| "INVALID_GRANT"
	| "INVALID_TOKEN_RESPONSE"

export class ClaudeCodeOAuthTokenError extends Error {
	constructor(
		public readonly code: ClaudeCodeOAuthTokenErrorCode,
		message: string,
		public readonly status?: number,
	) {
		super(message)
		this.name = "ClaudeCodeOAuthTokenError"
	}

	isInvalidGrant(): boolean {
		return this.code === "INVALID_GRANT"
	}
}

export interface ClaudeCodeOAuthConfiguration {
	authorizationEndpoint: string
	tokenEndpoint: string
	clientId: string
	scopes: string
	manualRedirectUri: string
	callbackPort: number
	callbackPorts?: readonly number[]
	callbackRedirectHost?: string
	callbackPath: string
}

export interface ClaudeCodeOAuthStrategyOptions {
	configuration?: Partial<ClaudeCodeOAuthConfiguration>
	fetchImpl?: typeof fetch
	now?: () => number
}

interface TokenResponse {
	accessToken: string
	refreshToken?: string
	expiresInSeconds: number
	scopes?: string
	accountId?: string
	email?: string
	displayName?: string
	organizationName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseTokenResponse(value: unknown): TokenResponse {
	if (!isRecord(value)) {
		throw new ClaudeCodeOAuthTokenError("INVALID_TOKEN_RESPONSE", "The OAuth token response was invalid.")
	}
	const accessToken = optionalString(value.access_token)
	const expiresInSeconds = value.expires_in
	if (!accessToken || typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
		throw new ClaudeCodeOAuthTokenError("INVALID_TOKEN_RESPONSE", "The OAuth token response was invalid.")
	}
	const account = isRecord(value.account) ? value.account : undefined
	const organization = isRecord(value.organization) ? value.organization : undefined
	return {
		accessToken,
		refreshToken: optionalString(value.refresh_token),
		expiresInSeconds,
		scopes: optionalString(value.scope),
		accountId: optionalString(account?.uuid),
		email: optionalString(account?.email_address) ?? optionalString(account?.email),
		displayName: optionalString(account?.display_name) ?? optionalString(account?.full_name),
		organizationName: optionalString(organization?.name),
	}
}

function parseProviderErrorCode(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined
	if (typeof value.error === "string") return value.error
	if (isRecord(value.error) && typeof value.error.type === "string") return value.error.type
	return undefined
}

/**
 * Encode the scope list the way the provider expects.
 *
 * `URLSearchParams` percent-encodes the separating spaces, which this endpoint
 * rejects; it requires the `+` form instead.
 */
function encodeScopes(scopes: string): string {
	return encodeURIComponent(scopes).replace(/%20/g, "+")
}

export class ClaudeCodeOAuthStrategy implements OAuthAuthorizationStrategy<ClaudeCodeOAuthCredentials> {
	readonly strategyId = "anthropic-claude-code"
	readonly providerDisplayName = "Claude Code"
	readonly callbackPort: number
	readonly callbackPorts: readonly number[]
	readonly callbackRedirectHost: string | undefined
	readonly callbackPath: string
	readonly manualRedirectUri: string
	private readonly configuration: ClaudeCodeOAuthConfiguration
	private readonly fetchImpl: typeof fetch
	private readonly now: () => number

	constructor(options: ClaudeCodeOAuthStrategyOptions = {}) {
		this.configuration = { ...CLAUDE_CODE_OAUTH_CONFIG, ...options.configuration }
		this.callbackPort = this.configuration.callbackPort
		this.callbackPorts = this.configuration.callbackPorts ?? [this.configuration.callbackPort]
		this.callbackRedirectHost = this.configuration.callbackRedirectHost
		this.callbackPath = this.configuration.callbackPath
		this.manualRedirectUri = this.configuration.manualRedirectUri
		this.fetchImpl = options.fetchImpl ?? fetch
		this.now = options.now ?? Date.now
	}

	/**
	 * Build the authorization URL for whichever redirect the caller selected.
	 *
	 * The hosted redirect additionally needs the leading `code=true` marker,
	 * which is what makes the provider render the copyable code page.
	 *
	 * Parameter order reproduces the observed client rather than following
	 * whatever order the parameters happen to be declared in. The query is
	 * semantically order-independent, but the emitted order is still part of
	 * what a request looks like on the wire.
	 */
	buildAuthorizationUrl(input: OAuthAuthorizationInput): URL {
		const url = new URL(this.configuration.authorizationEndpoint)
		const hosted = input.redirectUri === this.manualRedirectUri
		const query = [
			`client_id=${encodeURIComponent(this.configuration.clientId)}`,
			"response_type=code",
			`redirect_uri=${encodeURIComponent(input.redirectUri)}`,
			// The scope separator must stay `+`: this endpoint rejects the
			// percent-encoded space that a generic encoder would produce.
			`scope=${encodeScopes(this.configuration.scopes)}`,
			`code_challenge=${encodeURIComponent(input.codeChallenge)}`,
			"code_challenge_method=S256",
			`state=${encodeURIComponent(input.state)}`,
		].join("&")
		url.search = hosted ? `code=true&${query}` : query
		return url
	}

	/**
	 * Split a code pasted from the hosted page.
	 *
	 * That page renders `authorizationCode#state`; the fragment is optional
	 * because a user may copy only the leading code.
	 */
	parseManualCode(pastedValue: string): ParsedManualOAuthCode {
		const trimmed = pastedValue.trim()
		const separator = trimmed.indexOf("#")
		const code = separator === -1 ? trimmed : trimmed.slice(0, separator)
		const state = separator === -1 ? undefined : trimmed.slice(separator + 1).trim()
		if (!code) {
			throw new ClaudeCodeOAuthTokenError("INVALID_TOKEN_RESPONSE", "The pasted authorization code was empty.")
		}
		return { code, ...(state ? { state } : {}) }
	}

	async exchangeAuthorizationCode(input: OAuthCodeExchangeInput): Promise<ClaudeCodeOAuthCredentials> {
		// This token endpoint requires the state back whenever the authorization
		// returned one, on both the loopback and hosted paths.
		const state = input.callbackParams?.state
		const tokens = await this.requestTokens(
			{
				grant_type: "authorization_code",
				client_id: this.configuration.clientId,
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.codeVerifier,
				...(state ? { state } : {}),
			},
			"exchange",
		)
		return parseClaudeCodeOAuthCredentials({
			type: "claude-code",
			access_token: tokens.accessToken,
			...(tokens.refreshToken !== undefined ? { refresh_token: tokens.refreshToken } : {}),
			expires: this.expiryFrom(tokens.expiresInSeconds),
			...(tokens.scopes !== undefined ? { scopes: tokens.scopes } : {}),
			...(tokens.accountId !== undefined ? { accountId: tokens.accountId } : {}),
			...(tokens.email !== undefined ? { email: tokens.email } : {}),
			...(tokens.displayName !== undefined ? { displayName: tokens.displayName } : {}),
			...(tokens.organizationName !== undefined ? { organizationName: tokens.organizationName } : {}),
		})
	}

	async refreshCredential(credential: ClaudeCodeOAuthCredentials): Promise<ClaudeCodeOAuthCredentials> {
		const current = parseClaudeCodeOAuthCredentials(credential)
		if (!current.refresh_token) {
			throw new ClaudeCodeOAuthTokenError(
				"REFRESH_TOKEN_UNAVAILABLE",
				"The OAuth credential cannot be refreshed because it has no refresh token.",
			)
		}
		const tokens = await this.requestTokens(
			{
				grant_type: "refresh_token",
				client_id: this.configuration.clientId,
				refresh_token: current.refresh_token,
			},
			"refresh",
		)
		return parseClaudeCodeOAuthCredentials({
			type: current.type ?? "claude-code",
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken ?? current.refresh_token,
			expires: this.expiryFrom(tokens.expiresInSeconds),
			...((tokens.scopes ?? current.scopes) ? { scopes: tokens.scopes ?? current.scopes } : {}),
			...((tokens.accountId ?? current.accountId) ? { accountId: tokens.accountId ?? current.accountId } : {}),
			...((tokens.email ?? current.email) ? { email: tokens.email ?? current.email } : {}),
			...((tokens.displayName ?? current.displayName) ? { displayName: tokens.displayName ?? current.displayName } : {}),
			...((tokens.organizationName ?? current.organizationName)
				? { organizationName: tokens.organizationName ?? current.organizationName }
				: {}),
		})
	}

	/**
	 * Project the stored identity onto the neutral callback page presentation.
	 *
	 * Only labels already derived from the token response are exposed; no
	 * access token, refresh token, or account id reaches the rendered page.
	 */
	describeAccount(credential: ClaudeCodeOAuthCredentials): OAuthAccountPresentation {
		const accountName = credential.displayName ?? credential.email
		const accountDetail = credential.displayName && credential.email ? credential.email : undefined
		return {
			providerName: this.providerDisplayName,
			...(accountName ? { accountName } : {}),
			...(accountDetail ? { accountDetail } : {}),
			...(credential.organizationName ? { planName: credential.organizationName } : {}),
		}
	}

	/**
	 * Redeem or renew a grant.
	 *
	 * Unlike the Codex endpoint this one expects a JSON body, so the parameters
	 * are serialized rather than form-encoded.
	 */
	private async requestTokens(body: Record<string, string>, operation: "exchange" | "refresh"): Promise<TokenResponse> {
		let response: Response
		try {
			response = await this.fetchImpl(this.configuration.tokenEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			})
		} catch {
			throw new ClaudeCodeOAuthTokenError(
				operation === "exchange" ? "TOKEN_EXCHANGE_FAILED" : "TOKEN_REFRESH_FAILED",
				operation === "exchange"
					? "The OAuth authorization code could not be exchanged."
					: "The OAuth credential could not be refreshed.",
			)
		}

		const responseText = await response.text()
		let payload: unknown
		try {
			payload = JSON.parse(responseText)
		} catch {
			payload = undefined
		}
		if (!response.ok) {
			const providerCode = parseProviderErrorCode(payload)
			const invalidGrant =
				(providerCode !== undefined && /invalid_grant/i.test(providerCode)) || /invalid_grant/i.test(responseText)
			throw new ClaudeCodeOAuthTokenError(
				invalidGrant ? "INVALID_GRANT" : operation === "exchange" ? "TOKEN_EXCHANGE_FAILED" : "TOKEN_REFRESH_FAILED",
				invalidGrant
					? "The OAuth authorization grant is no longer valid."
					: operation === "exchange"
						? "The OAuth authorization code could not be exchanged."
						: "The OAuth credential could not be refreshed.",
				response.status,
			)
		}
		return parseTokenResponse(payload)
	}

	private expiryFrom(expiresInSeconds: number): number {
		const expires = this.now() + expiresInSeconds * 1_000
		if (!Number.isSafeInteger(expires)) {
			throw new ClaudeCodeOAuthTokenError("INVALID_TOKEN_RESPONSE", "The OAuth token response was invalid.")
		}
		return expires
	}
}

export function isClaudeCodeCredentialExpired(
	credential: ClaudeCodeOAuthCredentials,
	now = Date.now(),
	bufferMs = 5 * 60_000,
): boolean {
	return now >= parseClaudeCodeOAuthCredentials(credential).expires - bufferMs
}
