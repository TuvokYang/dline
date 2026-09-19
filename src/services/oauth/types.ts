export type OAuthFlowErrorCode =
	| "FLOW_ALREADY_IN_PROGRESS"
	| "CALLBACK_PORT_IN_USE"
	| "CALLBACK_SERVER_FAILED"
	| "FLOW_NOT_FOUND"
	| "FLOW_OWNER_MISMATCH"
	| "CALLBACK_URI_INVALID"
	| "CALLBACK_URI_MISMATCH"
	| "CALLBACK_MISSING_PARAMETERS"
	| "STATE_MISMATCH"
	| "AUTHORIZATION_DENIED"
	| "TOKEN_EXCHANGE_FAILED"
	| "CREDENTIAL_PERSIST_FAILED"
	| "BROWSER_OPEN_FAILED"
	| "FLOW_CANCELLED"
	| "FLOW_TIMED_OUT"

export class OAuthFlowError extends Error {
	constructor(
		public readonly code: OAuthFlowErrorCode,
		message: string,
		public readonly terminal = false,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = "OAuthFlowError"
	}
}

export interface OAuthAuthorizationInput {
	redirectUri: string
	codeChallenge: string
	state: string
}

export interface OAuthCodeExchangeInput {
	code: string
	codeVerifier: string
	redirectUri: string
}

/**
 * Provider-neutral account summary rendered on the OAuth callback page.
 *
 * Every field is presentation only. A strategy must never place a token, refresh
 * token, or PKCE secret here, because the value is written into a page served to
 * the browser that completed the authorization.
 */
export interface OAuthAccountPresentation {
	/** Human-readable provider name rendered on the callback page. */
	providerName: string
	/** Primary account label, usually a display name, email, or account id. */
	accountName?: string
	/** Secondary account label, usually the email when a display name exists. */
	accountDetail?: string
	/** Subscription or plan label, such as "Pro" or "Team". */
	planName?: string
}

export interface OAuthAuthorizationStrategy<TCredential> {
	readonly strategyId: string
	readonly callbackPort: number
	readonly callbackPorts?: readonly number[]
	readonly callbackPath: string
	/**
	 * Host published in `redirect_uri` when it must differ from the loopback bind address.
	 *
	 * Authorization servers compare `redirect_uri` as an exact string, so a provider whose
	 * allow-list registers `localhost` rejects an otherwise equivalent `127.0.0.1` callback.
	 */
	readonly callbackRedirectHost?: string
	/** Provider label rendered on the callback page when the strategy supplies one. */
	readonly providerDisplayName?: string
	buildAuthorizationUrl(input: OAuthAuthorizationInput): URL
	exchangeAuthorizationCode(input: OAuthCodeExchangeInput): Promise<TCredential>
	refreshCredential?(credential: TCredential): Promise<TCredential>
	/**
	 * Project a credential onto the callback page presentation.
	 *
	 * Optional so an existing strategy keeps working and simply renders a page
	 * without account details. Implementations must return presentation data only.
	 */
	describeAccount?(credential: TCredential): OAuthAccountPresentation | undefined
}

export interface OAuthFlowLeaseOwner {
	flowId: string
	profileId: string
	strategyId: string
}

export interface OAuthFlowLeaseHandle {
	release(): Promise<void>
}

export interface OAuthFlowLease {
	acquire(owner: OAuthFlowLeaseOwner): Promise<OAuthFlowLeaseHandle>
}

export type OAuthBrowserOpenStatus = "opened" | "failed"

export interface OAuthFlowStarted<TCredential> {
	flowId: string
	profileId: string
	authorizationUrl: string
	redirectUri: string
	expiresAtMs: number
	browserOpenStatus: OAuthBrowserOpenStatus
	result: Promise<TCredential>
}

export interface StartOAuthFlowInput {
	profileId: string
	flowId?: string
}

export interface CompleteOAuthCallbackInput {
	flowId: string
	profileId: string
	callbackUri: string
}

export interface CancelOAuthFlowInput {
	flowId: string
	profileId: string
}
