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
	| "MANUAL_CODE_UNSUPPORTED"
	| "MANUAL_CODE_INVALID"

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
	/**
	 * Everything the provider returned alongside the code.
	 *
	 * The coordinator validates the parameters OAuth itself defines and then
	 * forwards the whole set, because which of them a token endpoint expects
	 * back varies per provider. Keeping this opaque means supporting another
	 * provider's extra parameter is a strategy change, not a framework change.
	 *
	 * It is absent when the code did not arrive through a callback, such as a
	 * hosted page the user copied from.
	 */
	callbackParams?: Readonly<Record<string, string>>
}

/**
 * Authorization code recovered from a value the user pasted by hand.
 *
 * Providers that return the code on a hosted page may append the flow state to
 * it, so the state travels back through the paste rather than a query string.
 */
export interface ParsedManualOAuthCode {
	code: string
	state?: string
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
	/**
	 * Redirect URI of the provider-hosted page that displays the authorization code.
	 *
	 * Declaring it opts the strategy into manual completion, which stays available
	 * when no browser can reach the loopback server. The token exchange must echo
	 * this exact URI, so it is kept separate from the loopback redirect URI.
	 */
	readonly manualRedirectUri?: string
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
	/**
	 * Recover the authorization code from a value the user pasted.
	 *
	 * Required for manual completion because the paste is a bare code rather than
	 * a callback URL, so the loopback URI parser cannot validate it. Implementations
	 * should reject only what they cannot interpret and let the token endpoint judge
	 * the rest, since a code is opaque to the client.
	 */
	parseManualCode?(pastedValue: string): ParsedManualOAuthCode
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
	/**
	 * Authorization URL that routes the code to the provider-hosted page.
	 *
	 * Present only when the strategy supports manual completion. It is offered
	 * alongside the loopback URL so the user can choose either path, and it is the
	 * only option left when the callback server could not start.
	 */
	manualAuthorizationUrl?: string
	/** Whether the loopback callback server is listening for this flow. */
	loopbackListening: boolean
}

/**
 * One user-submitted completion value, whatever form it arrived in.
 *
 * A single input field is easier to explain than asking the user to classify
 * their own clipboard, so the coordinator decides whether the value is a
 * callback URL or a bare authorization code.
 */
export interface CompleteOAuthPastedValueInput {
	flowId: string
	profileId: string
	pastedValue: string
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
