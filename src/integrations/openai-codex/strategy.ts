import { type OpenAiOAuthCredentials, parseOpenAiOAuthCredentials } from "@/core/storage/secrets/OpenAiCodexProfileAuthRepository"
import type {
	OAuthAccountPresentation,
	OAuthAuthorizationInput,
	OAuthAuthorizationStrategy,
	OAuthCodeExchangeInput,
} from "@/services/oauth"
import { fetch as proxyFetch } from "@/shared/net"

/**
 * Authorization parameters mirror the current Codex CLI login flow.
 *
 * The provider matches `redirect_uri` as an exact string against its allow-list, so the published
 * host must be `localhost`; an otherwise equivalent `127.0.0.1` callback is rejected with
 * `invalid_authorize_request`. The connector scopes and `codex_cli_rs` originator track upstream
 * `codex-rs` so newly gated capabilities stay available.
 */
export const OPENAI_CODEX_OAUTH_CONFIG = {
	authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
	tokenEndpoint: "https://auth.openai.com/oauth/token",
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	scopes: "openid profile email offline_access api.connectors.read api.connectors.invoke",
	originator: "codex_cli_rs",
	callbackPort: 1455,
	callbackPorts: [1455, 1457] as readonly number[],
	callbackRedirectHost: "localhost",
	callbackPath: "/auth/callback",
} as const

export type OpenAiCodexOAuthTokenErrorCode =
	| "TOKEN_EXCHANGE_FAILED"
	| "TOKEN_REFRESH_FAILED"
	| "REFRESH_TOKEN_UNAVAILABLE"
	| "INVALID_GRANT"
	| "INVALID_TOKEN_RESPONSE"

export class OpenAiCodexOAuthTokenError extends Error {
	constructor(
		public readonly code: OpenAiCodexOAuthTokenErrorCode,
		message: string,
		public readonly status?: number,
	) {
		super(message)
		this.name = "OpenAiCodexOAuthTokenError"
	}

	isInvalidGrant(): boolean {
		return this.code === "INVALID_GRANT"
	}
}

export interface OpenAiCodexOAuthConfiguration {
	authorizationEndpoint: string
	tokenEndpoint: string
	clientId: string
	scopes: string
	originator: string
	callbackPort: number
	callbackPorts?: readonly number[]
	callbackRedirectHost?: string
	callbackPath: string
}

interface TokenResponse {
	accessToken: string
	refreshToken?: string
	idToken?: string
	expiresInSeconds: number
	email?: string
}

export interface OpenAiCodexOAuthStrategyOptions {
	configuration?: Partial<OpenAiCodexOAuthConfiguration>
	fetchImpl?: typeof proxyFetch
	now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseTokenResponse(value: unknown): TokenResponse {
	if (!isRecord(value)) {
		throw new OpenAiCodexOAuthTokenError("INVALID_TOKEN_RESPONSE", "The OAuth token response was invalid.")
	}
	const accessToken = optionalString(value.access_token)
	const expiresInSeconds = value.expires_in
	if (!accessToken || typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
		throw new OpenAiCodexOAuthTokenError("INVALID_TOKEN_RESPONSE", "The OAuth token response was invalid.")
	}
	return {
		accessToken,
		refreshToken: optionalString(value.refresh_token),
		idToken: optionalString(value.id_token),
		expiresInSeconds,
		email: optionalString(value.email),
	}
}

function parseProviderErrorCode(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined
	if (typeof value.error === "string") return value.error
	if (isRecord(value.error) && typeof value.error.type === "string") return value.error.type
	return undefined
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".")
	if (parts.length !== 3) return undefined
	try {
		const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
		return isRecord(value) ? value : undefined
	} catch {
		return undefined
	}
}

export type OpenAiCodexAccountIdSource =
	| "access-token-auth"
	| "access-token-default-organization"
	| "access-token-top-level"
	| "missing"

export interface OpenAiCodexAccessTokenAccountId {
	readonly accountId?: string
	readonly source: OpenAiCodexAccountIdSource
}

function accountIdFromClaims(claims: Record<string, unknown>): OpenAiCodexAccessTokenAccountId {
	const auth = claims["https://api.openai.com/auth"]
	const authAccountId = isRecord(auth) ? optionalString(auth.chatgpt_account_id) : undefined
	if (authAccountId) {
		return { accountId: authAccountId, source: "access-token-auth" }
	}

	const organizations = claims.organizations
	if (Array.isArray(organizations)) {
		const defaultOrganization = organizations.find(
			(organization) => isRecord(organization) && organization.is_default === true,
		)
		if (isRecord(defaultOrganization)) {
			const defaultOrganizationId = optionalString(defaultOrganization.id)
			if (defaultOrganizationId) {
				return { accountId: defaultOrganizationId, source: "access-token-default-organization" }
			}
		}
	}

	const topLevelAccountId = optionalString(claims.chatgpt_account_id)
	return topLevelAccountId ? { accountId: topLevelAccountId, source: "access-token-top-level" } : { source: "missing" }
}

/** Resolve the account header exactly as the official Codex client does. */
export function resolveOpenAiCodexAccessTokenAccountId(accessToken: string): OpenAiCodexAccessTokenAccountId {
	const claims = parseJwtClaims(accessToken)
	return claims ? accountIdFromClaims(claims) : { source: "missing" }
}

interface OpenAiCodexTokenIdentity {
	accountId?: string
	displayName?: string
	email?: string
	accountType?: string
}

function identityFromClaims(claims: Record<string, unknown>): OpenAiCodexTokenIdentity {
	const profile = claims["https://api.openai.com/profile"]
	const auth = claims["https://api.openai.com/auth"]
	return {
		displayName:
			optionalString(claims.name) ??
			(isRecord(profile) ? optionalString(profile.name) : undefined) ??
			optionalString(claims.preferred_username),
		email: optionalString(claims.email) ?? (isRecord(profile) ? optionalString(profile.email) : undefined),
		accountType: isRecord(auth) ? optionalString(auth.chatgpt_plan_type) : undefined,
	}
}

function extractTokenIdentity(tokens: Pick<TokenResponse, "accessToken" | "idToken">): OpenAiCodexTokenIdentity {
	const { accountId } = resolveOpenAiCodexAccessTokenAccountId(tokens.accessToken)
	let displayName: string | undefined
	let email: string | undefined
	let accountType: string | undefined
	for (const token of [tokens.idToken, tokens.accessToken]) {
		if (!token) continue
		const claims = parseJwtClaims(token)
		if (!claims) continue
		const identity = identityFromClaims(claims)
		displayName ??= identity.displayName
		email ??= identity.email
		accountType ??= identity.accountType
	}
	return { accountId, displayName, email, accountType }
}

export function resolveOpenAiCodexStoredAccountIdentity(credential: OpenAiOAuthCredentials): OpenAiCodexTokenIdentity {
	const tokenIdentity = extractTokenIdentity({ accessToken: credential.access_token })
	return {
		accountId: tokenIdentity.accountId ?? credential.accountId,
		displayName: credential.displayName ?? tokenIdentity.displayName,
		email: credential.email ?? tokenIdentity.email,
		accountType: credential.accountType ?? tokenIdentity.accountType,
	}
}

/**
 * Turn a raw plan claim such as `chatgpt_plan_type` into a display label.
 *
 * Upstream reports lowercase, sometimes delimited values like `pro` or
 * `team_admin`, which read poorly beside a provider name.
 */
function formatPlanName(accountType: string): string {
	return accountType
		.split(/[\s_-]+/)
		.filter((segment) => segment.length > 0)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(" ")
}

export class OpenAiCodexOAuthStrategy implements OAuthAuthorizationStrategy<OpenAiOAuthCredentials> {
	readonly strategyId = "openai-codex"
	readonly providerDisplayName = "OpenAI Codex"
	readonly callbackPort: number
	readonly callbackPorts: readonly number[]
	readonly callbackRedirectHost: string | undefined
	readonly callbackPath: string
	private readonly configuration: OpenAiCodexOAuthConfiguration
	private readonly fetchImpl: typeof proxyFetch
	private readonly now: () => number

	constructor(options: OpenAiCodexOAuthStrategyOptions = {}) {
		this.configuration = { ...OPENAI_CODEX_OAUTH_CONFIG, ...options.configuration }
		this.callbackPort = this.configuration.callbackPort
		this.callbackPorts = this.configuration.callbackPorts ?? [this.configuration.callbackPort]
		this.callbackRedirectHost = this.configuration.callbackRedirectHost
		this.callbackPath = this.configuration.callbackPath
		this.fetchImpl = options.fetchImpl ?? proxyFetch
		this.now = options.now ?? Date.now
	}

	buildAuthorizationUrl(input: OAuthAuthorizationInput): URL {
		const url = new URL(this.configuration.authorizationEndpoint)
		url.search = new URLSearchParams({
			client_id: this.configuration.clientId,
			redirect_uri: input.redirectUri,
			scope: this.configuration.scopes,
			code_challenge: input.codeChallenge,
			code_challenge_method: "S256",
			response_type: "code",
			id_token_add_organizations: "true",
			state: input.state,
			codex_cli_simplified_flow: "true",
			originator: this.configuration.originator,
		}).toString()
		return url
	}

	async exchangeAuthorizationCode(input: OAuthCodeExchangeInput): Promise<OpenAiOAuthCredentials> {
		const tokens = await this.requestTokens(
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: this.configuration.clientId,
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.codeVerifier,
			}),
			"exchange",
		)
		const identity = extractTokenIdentity(tokens)
		return parseOpenAiOAuthCredentials({
			type: "openai-codex",
			access_token: tokens.accessToken,
			...(tokens.refreshToken !== undefined ? { refresh_token: tokens.refreshToken } : {}),
			expires: this.expiryFrom(tokens.expiresInSeconds),
			displayName: identity.displayName,
			email: tokens.email ?? identity.email,
			accountId: identity.accountId,
			accountType: identity.accountType,
		})
	}

	/**
	 * Project the stored identity onto the neutral callback page presentation.
	 *
	 * Only labels already derived from token claims are exposed; no access token,
	 * refresh token, or account id secret reaches the rendered page.
	 */
	describeAccount(credential: OpenAiOAuthCredentials): OAuthAccountPresentation {
		const identity = resolveOpenAiCodexStoredAccountIdentity(credential)
		const accountName = identity.displayName ?? identity.email ?? identity.accountId
		const accountDetail = identity.displayName && identity.email ? identity.email : undefined
		return {
			providerName: this.providerDisplayName,
			...(accountName ? { accountName } : {}),
			...(accountDetail ? { accountDetail } : {}),
			...(identity.accountType ? { planName: formatPlanName(identity.accountType) } : {}),
		}
	}

	async refreshCredential(credential: OpenAiOAuthCredentials): Promise<OpenAiOAuthCredentials> {
		const current = parseOpenAiOAuthCredentials(credential)
		if (!current.refresh_token) {
			throw new OpenAiCodexOAuthTokenError(
				"REFRESH_TOKEN_UNAVAILABLE",
				"The OAuth credential cannot be refreshed because it has no refresh token.",
			)
		}
		const tokens = await this.requestTokens(
			new URLSearchParams({
				grant_type: "refresh_token",
				client_id: this.configuration.clientId,
				refresh_token: current.refresh_token,
			}),
			"refresh",
		)
		const identity = extractTokenIdentity(tokens)
		return parseOpenAiOAuthCredentials({
			...(current.type !== undefined ? { type: current.type } : {}),
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken ?? current.refresh_token,
			expires: this.expiryFrom(tokens.expiresInSeconds),
			displayName: identity.displayName ?? current.displayName,
			email: tokens.email ?? identity.email ?? current.email,
			accountId: identity.accountId ?? current.accountId,
			accountType: identity.accountType ?? current.accountType,
		})
	}

	private async requestTokens(body: URLSearchParams, operation: "exchange" | "refresh"): Promise<TokenResponse> {
		let response: Response
		try {
			response = await this.fetchImpl(this.configuration.tokenEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
				signal: AbortSignal.timeout(30_000),
			})
		} catch {
			throw new OpenAiCodexOAuthTokenError(
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
			throw new OpenAiCodexOAuthTokenError(
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
			throw new OpenAiCodexOAuthTokenError("INVALID_TOKEN_RESPONSE", "The OAuth token response was invalid.")
		}
		return expires
	}
}

export function isOpenAiCodexCredentialExpired(
	credential: OpenAiOAuthCredentials,
	now = Date.now(),
	bufferMs = 5 * 60_000,
): boolean {
	return now >= parseOpenAiOAuthCredentials(credential).expires - bufferMs
}
