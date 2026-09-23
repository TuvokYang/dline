import { randomUUID } from "node:crypto"
import { type ParsedOAuthCallback, parseOAuthCallbackUri } from "./callbackUri"
import { LocalOAuthCallbackServer } from "./LocalOAuthCallbackServer"
import { createOAuthState, createPkceChallenge, createPkceVerifier } from "./pkce"
import {
	type CancelOAuthFlowInput,
	type CompleteOAuthCallbackInput,
	type CompleteOAuthPastedValueInput,
	type OAuthAccountPresentation,
	type OAuthAuthorizationStrategy,
	OAuthFlowError,
	type OAuthFlowLease,
	type OAuthFlowLeaseHandle,
	type OAuthFlowStarted,
	type StartOAuthFlowInput,
} from "./types"

export interface OAuthCredentialPersistenceInput<TCredential> {
	flowId: string
	profileId: string
	credential: TCredential
}

export interface CoordinatorOptions<TCredential> {
	lease: OAuthFlowLease
	openExternal: (authorizationUrl: string) => Promise<void>
	onCredential?: (input: OAuthCredentialPersistenceInput<TCredential>) => Promise<void>
	timeoutMs?: number
}

interface PendingFlow<TCredential> {
	flowId: string
	profileId: string
	state: string
	codeVerifier: string
	/** Loopback redirect URI; absent when the callback server could not start. */
	redirectUri?: string
	/** Hosted redirect URI echoed when the user completes the flow by pasting a code. */
	manualRedirectUri?: string
	server?: LocalOAuthCallbackServer
	lease: OAuthFlowLeaseHandle
	timeout: ReturnType<typeof setTimeout>
	result: Promise<TCredential>
	resolve: (credential: TCredential) => void
	reject: (error: OAuthFlowError) => void
	completion?: Promise<TCredential>
}

export class LocalOAuthFlowCoordinator<TCredential> {
	private pending: PendingFlow<TCredential> | undefined
	private lastTimedOutFlow: { flowId: string; profileId: string } | undefined
	private callbackServerCloseBarrier: Promise<void> = Promise.resolve()
	private readonly timeoutMs: number

	constructor(
		private readonly strategy: OAuthAuthorizationStrategy<TCredential>,
		private readonly options: CoordinatorOptions<TCredential>,
	) {
		this.timeoutMs = options.timeoutMs ?? 5 * 60_000
	}

	async startFlow(input: StartOAuthFlowInput): Promise<OAuthFlowStarted<TCredential>> {
		if (this.pending) throw new OAuthFlowError("FLOW_ALREADY_IN_PROGRESS", "An OAuth authorization flow is already active.")
		await this.callbackServerCloseBarrier
		if (this.pending) throw new OAuthFlowError("FLOW_ALREADY_IN_PROGRESS", "An OAuth authorization flow is already active.")
		const flowId = input.flowId ?? randomUUID()
		const lease = await this.options.lease.acquire({
			flowId,
			profileId: input.profileId,
			strategyId: this.strategy.strategyId,
		})
		const codeVerifier = createPkceVerifier()
		const state = createOAuthState()
		const manualRedirectUri = this.strategy.manualRedirectUri
		let server: LocalOAuthCallbackServer | undefined
		try {
			server = await this.listenForCallback(flowId, input.profileId)
		} catch (error) {
			// Manual completion does not need the loopback server, so a strategy that
			// offers it degrades to the paste path instead of failing the sign-in.
			if (!manualRedirectUri) {
				await lease.release()
				throw error
			}
		}

		let resolve!: (credential: TCredential) => void
		let reject!: (error: OAuthFlowError) => void
		const result = new Promise<TCredential>((res, rej) => {
			resolve = res
			reject = rej
		})
		void result.catch(() => undefined)
		const expiresAtMs = Date.now() + this.timeoutMs
		const timeout = setTimeout(() => {
			void this.fail(flowId, new OAuthFlowError("FLOW_TIMED_OUT", "The OAuth authorization flow timed out.", true))
		}, this.timeoutMs)
		this.pending = {
			flowId,
			profileId: input.profileId,
			state,
			codeVerifier,
			...(server ? { redirectUri: server.redirectUri, server } : {}),
			...(manualRedirectUri ? { manualRedirectUri } : {}),
			lease,
			timeout,
			result,
			resolve,
			reject,
		}

		// Both paths authorize the same flow, so they share one PKCE pair and state
		// and differ only in where the provider sends the resulting code.
		const codeChallenge = createPkceChallenge(codeVerifier)
		const buildUrl = (redirectUri: string) =>
			this.strategy.buildAuthorizationUrl({ redirectUri, codeChallenge, state }).toString()
		const manualAuthorizationUrl = manualRedirectUri ? buildUrl(manualRedirectUri) : undefined
		// Without a callback server the manual URL is the only way to authorize, so
		// it also becomes the URL opened in the browser.
		const authorizationUrl = server ? buildUrl(server.redirectUri) : (manualAuthorizationUrl as string)
		let browserOpenStatus: "opened" | "failed" = "opened"
		try {
			await this.options.openExternal(authorizationUrl)
		} catch {
			browserOpenStatus = "failed"
		}
		return {
			flowId,
			profileId: input.profileId,
			authorizationUrl,
			redirectUri: server?.redirectUri ?? (manualRedirectUri as string),
			expiresAtMs,
			browserOpenStatus,
			result,
			...(manualAuthorizationUrl ? { manualAuthorizationUrl } : {}),
			loopbackListening: server !== undefined,
		}
	}

	async completeFromCallbackUri(input: CompleteOAuthCallbackInput): Promise<TCredential> {
		return this.complete(input.flowId, input.profileId, input.callbackUri, true)
	}

	/**
	 * Complete the flow from whatever the user pasted.
	 *
	 * The two accepted forms are distinguishable without asking the user: a
	 * callback URL always parses as an absolute http(s) URL, and an authorization
	 * code never does.
	 */
	async completeFromPastedValue(input: CompleteOAuthPastedValueInput): Promise<TCredential> {
		const pasted = input.pastedValue.trim()
		if (!pasted) throw new OAuthFlowError("MANUAL_CODE_INVALID", "Paste the callback URL or the authorization code.")
		if (looksLikeAbsoluteHttpUrl(pasted)) return this.complete(input.flowId, input.profileId, pasted, true)
		return this.completeFromManualCode(input.flowId, input.profileId, pasted)
	}

	async cancelFlow(input: CancelOAuthFlowInput): Promise<void> {
		const pending = this.requirePending(input.flowId, input.profileId)
		await this.settleFailure(
			pending,
			new OAuthFlowError("FLOW_CANCELLED", "The OAuth authorization flow was cancelled.", true),
			true,
		)
	}

	async dispose(): Promise<void> {
		if (this.pending) {
			await this.settleFailure(
				this.pending,
				new OAuthFlowError("FLOW_CANCELLED", "The OAuth authorization flow was cancelled.", true),
				true,
			)
		}
		await this.callbackServerCloseBarrier
	}

	/**
	 * Exchange an authorization code the user recovered from the hosted page.
	 *
	 * The paste is a bare code rather than a callback URL, so the strategy parses
	 * it and the exchange echoes the hosted redirect URI the provider authorized.
	 */
	private completeFromManualCode(flowId: string, profileId: string, pastedValue: string): Promise<TCredential> {
		const pending = this.requirePending(flowId, profileId)
		if (pending.completion) return pending.completion
		const manualRedirectUri = pending.manualRedirectUri
		if (!manualRedirectUri || !this.strategy.parseManualCode) {
			throw new OAuthFlowError(
				"MANUAL_CODE_UNSUPPORTED",
				"This provider cannot be signed in with a pasted authorization code.",
			)
		}
		let parsed: { code: string; state?: string }
		try {
			parsed = this.strategy.parseManualCode(pastedValue)
		} catch (error) {
			throw error instanceof OAuthFlowError
				? error
				: new OAuthFlowError("MANUAL_CODE_INVALID", "The pasted authorization code could not be read.", false, {
						cause: error,
					})
		}
		// The hosted page may echo the flow state next to the code. Verify it when
		// present; its absence is normal and the code itself remains single-use.
		if (parsed.state !== undefined && parsed.state !== pending.state) {
			const mismatch = new OAuthFlowError(
				"STATE_MISMATCH",
				"The pasted authorization code belongs to another sign-in attempt.",
				true,
			)
			void this.settleFailure(pending, mismatch, true)
			throw mismatch
		}
		// The hosted page returns the state next to the code rather than in a
		// query string, so it is reassembled into the same shape a callback
		// would have produced.
		return this.exchange(
			pending,
			parsed.code,
			manualRedirectUri,
			true,
			parsed.state !== undefined ? { code: parsed.code, state: parsed.state } : undefined,
		)
	}

	private complete(flowId: string, profileId: string, callbackUri: string, waitForServer: boolean): Promise<TCredential> {
		const pending = this.requirePending(flowId, profileId)
		if (pending.completion) return pending.completion
		const redirectUri = pending.redirectUri
		if (!redirectUri) {
			throw new OAuthFlowError("CALLBACK_URI_MISMATCH", "This sign-in has no loopback callback to complete.")
		}
		let parsed: ParsedOAuthCallback
		try {
			parsed = parseOAuthCallbackUri(callbackUri, redirectUri, pending.state)
		} catch (error) {
			if (error instanceof OAuthFlowError && error.terminal) void this.settleFailure(pending, error, waitForServer)
			throw error
		}
		return this.exchange(pending, parsed.code, redirectUri, waitForServer, parsed.params)
	}

	/**
	 * Redeem one authorization code and settle the flow.
	 *
	 * `redirectUri` differs per completion path and must match the value used
	 * during authorization, because the token endpoint compares them.
	 */
	private exchange(
		pending: PendingFlow<TCredential>,
		code: string,
		redirectUri: string,
		waitForServer: boolean,
		callbackParams?: Readonly<Record<string, string>>,
	): Promise<TCredential> {
		pending.completion = this.strategy
			.exchangeAuthorizationCode({
				code,
				codeVerifier: pending.codeVerifier,
				redirectUri,
				...(callbackParams ? { callbackParams } : {}),
			})
			.then(async (credential) => {
				if (this.options.onCredential) {
					try {
						await this.options.onCredential({ flowId: pending.flowId, profileId: pending.profileId, credential })
					} catch {
						throw new OAuthFlowError("CREDENTIAL_PERSIST_FAILED", "The OAuth credential could not be saved.", true)
					}
				}
				await this.settleSuccess(pending, credential, waitForServer)
				return credential
			})
			.catch(async (error: unknown) => {
				const wrapped =
					error instanceof OAuthFlowError
						? error
						: new OAuthFlowError(
								"TOKEN_EXCHANGE_FAILED",
								"The OAuth authorization code could not be exchanged.",
								true,
								{
									cause: error,
								},
							)
				// The authorization itself succeeded, so keep the flow alive and let
				// the user retry through the remaining completion path. Settling here
				// would strand them with a dialog whose buttons no longer resolve to
				// an active flow.
				if (pending.manualRedirectUri && this.pending === pending) {
					pending.completion = undefined
				} else {
					await this.settleFailure(pending, wrapped, waitForServer)
				}
				throw wrapped
			})
		return pending.completion
	}

	private requirePending(flowId: string, profileId: string): PendingFlow<TCredential> {
		const pending = this.pending
		if (!pending || pending.flowId !== flowId) {
			if (this.lastTimedOutFlow?.flowId === flowId) {
				if (this.lastTimedOutFlow.profileId !== profileId) {
					throw new OAuthFlowError("FLOW_OWNER_MISMATCH", "The OAuth authorization flow belongs to another profile.")
				}
				throw new OAuthFlowError("FLOW_TIMED_OUT", "The OAuth authorization flow timed out.", true)
			}
			throw new OAuthFlowError("FLOW_NOT_FOUND", "The OAuth authorization flow is no longer active.")
		}
		if (pending.profileId !== profileId)
			throw new OAuthFlowError("FLOW_OWNER_MISMATCH", "The OAuth authorization flow belongs to another profile.")
		return pending
	}

	private async fail(flowId: string, error: OAuthFlowError): Promise<void> {
		if (!this.pending || this.pending.flowId !== flowId) return
		if (error.code === "FLOW_TIMED_OUT") {
			this.lastTimedOutFlow = { flowId: this.pending.flowId, profileId: this.pending.profileId }
		}
		await this.settleFailure(this.pending, error, true)
	}

	private async listenForCallback(flowId: string, profileId: string): Promise<LocalOAuthCallbackServer> {
		const configuredPorts = this.strategy.callbackPorts?.length ? this.strategy.callbackPorts : [this.strategy.callbackPort]
		const ports = [...new Set(configuredPorts)]
		let lastPortError: OAuthFlowError | undefined
		for (const port of ports) {
			try {
				return await LocalOAuthCallbackServer.listen({
					port,
					callbackPath: this.strategy.callbackPath,
					...(this.strategy.callbackRedirectHost !== undefined
						? { redirectHost: this.strategy.callbackRedirectHost }
						: {}),
					onCallback: (callbackUri) =>
						this.complete(flowId, profileId, callbackUri, false).then((credential) =>
							this.describeAccount(credential),
						),
				})
			} catch (error) {
				if (!(error instanceof OAuthFlowError) || error.code !== "CALLBACK_PORT_IN_USE") throw error
				lastPortError = error
			}
		}
		throw lastPortError ?? new OAuthFlowError("CALLBACK_SERVER_FAILED", "No OAuth callback port was configured.")
	}

	/**
	 * Project a credential onto the callback page presentation.
	 *
	 * The authorization already succeeded at this point, so a strategy that fails
	 * to describe the account degrades to a page without account details instead
	 * of turning a successful flow into a failure.
	 */
	private describeAccount(credential: TCredential): OAuthAccountPresentation | undefined {
		try {
			return this.strategy.describeAccount?.(credential)
		} catch {
			return undefined
		}
	}

	private async settleSuccess(
		pending: PendingFlow<TCredential>,
		credential: TCredential,
		waitForServer: boolean,
	): Promise<void> {
		await this.cleanup(pending, waitForServer)
		pending.resolve(credential)
	}

	private async settleFailure(pending: PendingFlow<TCredential>, error: OAuthFlowError, waitForServer: boolean): Promise<void> {
		await this.cleanup(pending, waitForServer)
		pending.reject(error)
	}

	private async cleanup(pending: PendingFlow<TCredential>, waitForServer: boolean): Promise<void> {
		if (this.pending !== pending) return
		const serverClose = pending.server?.close() ?? Promise.resolve()
		this.callbackServerCloseBarrier = serverClose.catch(() => undefined)
		this.pending = undefined
		clearTimeout(pending.timeout)
		await pending.lease.release()
		if (waitForServer) await serverClose
	}
}

/**
 * Whether a pasted value is an absolute http(s) URL.
 *
 * Authorization codes are opaque, but they are not absolute URLs, so this
 * separates the two accepted paste forms without inspecting code contents.
 */
function looksLikeAbsoluteHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value)
		return protocol === "http:" || protocol === "https:"
	} catch {
		return false
	}
}
