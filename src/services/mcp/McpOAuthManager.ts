import path from "node:path"
import { deleteMcpOAuthServer, getMcpOAuthServer, type McpOAuthServerData, updateMcpOAuthServer } from "@core/storage/secrets"
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import crypto from "crypto"
import { getDlineDataDir } from "@/core/storage/disk"
import { HostProvider } from "@/hosts/host-provider"
import { FileOAuthFlowLease, LocalOAuthFlowCoordinator, type OAuthFlowLease } from "@/services/oauth"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"
import { getMcpServerCallbackPath, getServerAuthHash } from "@/utils/mcpAuth"
import { McpOAuthFlowStrategy } from "./McpOAuthFlowStrategy"
import { isCallbackPortInUse, McpOAuthLoopback, McpOAuthReregistrationRequiredError } from "./McpOAuthLoopback"
import { McpOAuthRedirectResolver } from "./McpOAuthRedirectResolver"

/** Redeems an authorization code through the server's MCP transport (SDK `finishAuth`). */
export type McpOAuthCodeExchange = (serverHash: string, code: string) => Promise<void>

/** An authorization running on the shared OAuth coordinator. */
export interface McpOAuthFlow {
    /** Settles once the browser returned and tokens were saved, or the flow failed, timed out or was cancelled. */
    result: Promise<void>
}

/** The SDK has not prepared an authorization URL yet; reconnecting after invalidation can create it. */
export class McpOAuthAuthorizationNotPreparedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "McpOAuthAuthorizationNotPreparedError"
    }
}

export interface McpOAuthAuthorizationRequired {
    readonly serverName: string
    readonly serverUrl: string
    readonly reauthorization: boolean
}

export interface McpOAuthManagerOptions {
    /** Lease that keeps one authorization per server across Dline windows. */
    leaseFor?: (serverHash: string) => OAuthFlowLease
    openExternal?: (url: string) => Promise<void>
    /** Announces the SDK's prepared authorization URL even when a reconnect hides its error. */
    onAuthorizationRequired?: (event: McpOAuthAuthorizationRequired) => void | Promise<void>
}

/** An authorization may take a while when the user has to sign in or create an account first. */
const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How long an overlapping auth() call waits for the registration another call in this window is
 * running. A registration that fails never reaches the provider, so the wait has to end on its own.
 */
const REGISTRATION_WAIT_MS = 30 * 1000

/** OAuth data persisted for one MCP server, shared by every Dline window. */
interface McpOAuthServerSecrets {
    tokens?: OAuthTokens
    tokens_saved_at?: number
    client_info?: OAuthClientInformationFull
    redirect_url_at_registration?: string
    code_verifier?: string
    oauth_state?: string
    oauth_state_timestamp?: number
    pending_auth_url?: string
    reauthorization_required?: boolean
}

interface OAuthTokenIdentity {
    readonly accessToken: string
    readonly refreshToken?: string
}

/** The latest persisted data for a server, including what other windows wrote. */
function readServerSecrets(serverHash: string): McpOAuthServerSecrets | undefined {
    return getMcpOAuthServer(serverHash) as McpOAuthServerSecrets | undefined
}

/** Changes a server's data on top of its latest persisted copy; undefined removes it. */
function updateServerSecrets(
    serverHash: string,
    change: (current: McpOAuthServerSecrets) => McpOAuthServerSecrets | undefined,
): void {
    updateMcpOAuthServer(serverHash, (current) => change(current as McpOAuthServerSecrets) as McpOAuthServerData | undefined)
}

/** A dynamic registration one auth() call is running; overlapping calls wait for it instead of registering their own client. */
class PendingRegistration {
    readonly settled: Promise<void>
    private finish: () => void = () => {}
    private readonly timer: ReturnType<typeof setTimeout>

    constructor(timeoutMs: number) {
        this.settled = new Promise((resolve) => {
            this.finish = resolve
        })
        this.timer = setTimeout(() => this.finish(), timeoutMs)
        this.timer.unref?.()
    }

    complete(): void {
        clearTimeout(this.timer)
        this.finish()
    }
}

/**
 * Implementation of OAuthClientProvider for Dline
 * Manages OAuth state and token storage for a single MCP server
 */
class DlineOAuthClientProvider implements OAuthClientProvider {
    private serverName: string
    private serverUrl: string
    private _redirectUrl: string
    private serverHash: string
    private readonly loopback: McpOAuthLoopback
    /** The registration an auth() call in this window is running, if any. */
    private registration: PendingRegistration | undefined
    /** Credential identities last handed to the SDK, used to avoid deleting a newer cross-window rotation. */
    private lastClientIdRead: string | undefined
    private lastTokensRead: OAuthTokenIdentity | undefined

    constructor(
        serverName: string,
        serverUrl: string,
        loopback: McpOAuthLoopback,
        private readonly onAuthorizationRequired?: (event: McpOAuthAuthorizationRequired) => void | Promise<void>,
    ) {
        this.serverName = serverName
        this.serverUrl = serverUrl
        this.serverHash = getServerAuthHash(serverName, serverUrl)
        this.loopback = loopback

        // The redirect URL is resolved when initialize() is called
        this._redirectUrl = ""
    }

    async initialize(): Promise<void> {
        // Get the full callback URL with the MCP server-specific path,
        // attempting to reuse the previously-registered port to preserve the OAuth client registration.
        const callbackPath = getMcpServerCallbackPath(this.serverName, this.serverUrl)
        const savedRedirectUrl = readServerSecrets(this.serverHash)?.redirect_url_at_registration

        const resolution = await McpOAuthRedirectResolver.resolve(
            savedRedirectUrl,
            callbackPath,
            this.loopback.callbackUrlSource(this.serverHash, HostProvider.get().getCallbackUrl),
        )

        this._redirectUrl = resolution.redirectUrl
    }

    get redirectUrl(): string {
        return this._redirectUrl
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            redirect_uris: [this._redirectUrl],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            client_name: "Dline",
            client_uri: "https://dline.cc",
            software_id: "dline",
        }
    }

    state(): string {
        // State is managed through storage, not instance variable
        return crypto.randomBytes(32).toString("hex")
    }

    /**
     * The client to use, or undefined when the SDK has to register one.
     *
     * The SDK registers whenever this returns undefined. A client another window registered is
     * read from the shared store, and overlapping auth() calls in this window wait for the one
     * registration already running, so each server and redirect gets a single client.
     */
    async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
        for (;;) {
            const registered = this.registeredClient()
            if (registered) {
                return registered
            }
            const pending = this.registration
            if (!pending) {
                Logger.log(`[McpOAuth] Registering an OAuth client for ${this.serverName}`)
                this.registration = new PendingRegistration(REGISTRATION_WAIT_MS)
                return undefined
            }
            await pending.settled
            if (this.registration === pending) {
                // It timed out without saving a client; the next caller to find none registers.
                this.registration = undefined
            }
        }
    }

    async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
        this.lastClientIdRead = clientInformation.client_id
        updateServerSecrets(this.serverHash, (current) => {
            const next: McpOAuthServerSecrets = {
                ...current,
                client_info: clientInformation,
                redirect_url_at_registration: this._redirectUrl,
            }
            if (current.client_info?.client_id !== clientInformation.client_id) {
                // Tokens are bound to the client that obtained them and are refused for a new one.
                delete next.tokens
                delete next.tokens_saved_at
            }
            return next
        })
        this.registration?.complete()
        this.registration = undefined
    }

    /** The persisted client, when it was registered for the redirect this provider serves. */
    private registeredClient(): OAuthClientInformationFull | undefined {
        const secrets = readServerSecrets(this.serverHash)
        // A client registered for another redirect (an earlier port, another platform) is refused by
        // the server, and one saved without its redirect cannot be trusted either.
        const client = secrets?.redirect_url_at_registration === this._redirectUrl ? secrets.client_info : undefined
        this.lastClientIdRead = client?.client_id
        return client
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        // Called by the SDK to check if we have valid tokens
        // This is called:
        // - During connection setup (to check if auth is needed)
        // - Before each request (to include Authorization header)
        // - During token refresh (to get refresh_token)
        //
        // IMPORTANT: We should return expired tokens if they have a refresh_token
        // The SDK will automatically attempt to refresh them
        // Only return undefined if we have NO tokens at all

        const serverData = readServerSecrets(this.serverHash)

        if (!serverData?.tokens) {
            this.lastTokensRead = undefined
            return undefined
        }
        this.lastTokensRead = tokenIdentity(serverData.tokens)

        // Check token expiration if timestamp exists
        if (serverData.tokens_saved_at && serverData.tokens.expires_in) {
            const expiresInMs = serverData.tokens.expires_in * 1000

            if (serverData.tokens_saved_at + expiresInMs < Date.now()) {
                // Token is expired
                // If we have a refresh_token, return the expired tokens so SDK can refresh
                // Otherwise return undefined to trigger full re-authentication
                if (serverData.tokens.refresh_token) {
                    Logger.log(`[McpOAuth] Token expired for ${this.serverName}, will attempt refresh`)
                    return serverData.tokens
                }
                return undefined
            }
        }

        return serverData.tokens
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        // Called by the SDK after successful token exchange
        // Flow: finishAuth(code) → SDK's auth() → exchangeAuthorization() → THIS METHOD
        // Stores tokens in the single mcpOAuthSecrets JSON for persistence
        Logger.log(`[McpOAuth] Tokens saved for ${this.serverName}`)
        this.lastTokensRead = tokenIdentity(tokens)

        updateServerSecrets(this.serverHash, (current) => {
            const next = { ...current, tokens, tokens_saved_at: Date.now() }
            delete next.pending_auth_url
            delete next.code_verifier
            delete next.oauth_state
            delete next.oauth_state_timestamp
            delete next.reauthorization_required
            return next
        })
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        // ========================================================================
        // IMPORTANT: This is called AUTOMATICALLY by the MCP SDK during connection
        // ========================================================================
        //
        // Flow:
        // 1. Extension loads → McpHub.connectToServer() is called
        // 2. authProvider.tokens() returns undefined (no tokens yet)
        // 3. client.connect(transport) is called
        // 4. SDK detects no tokens → calls auth(provider, {serverUrl})
        // 5. SDK internally calls startAuthorization() to generate OAuth URL
        // 6. SDK calls THIS METHOD with the generated authorizationUrl
        // 7. SDK throws UnauthorizedError (caught by McpHub to show "Authenticate" button)
        //
        // Our Strategy:
        // - Store the auth URL but DON'T open browser yet
        // - Wait for user to explicitly click "Authenticate" button
        // - When clicked, the flow adds a fresh PKCE challenge and state and opens the browser (see startOAuthFlow())
        //
        // This prevents automatic browser popups on every extension load!
        // ========================================================================

        // Keep the SDK-built URL (endpoint, client_id, redirect_uri, scope, resource) for the
        // Authenticate click; state is created per click so a retry never reuses a consumed one.
        // The SDK reaches this method only after deciding that existing credentials cannot complete
        // the request, so retaining tokens must not suppress the recovery URL.
        let reauthorization = false
        updateServerSecrets(this.serverHash, (current) => {
            reauthorization = Boolean(current.tokens || current.reauthorization_required)
            return {
                ...current,
                pending_auth_url: authorizationUrl.toString(),
                ...(reauthorization ? { reauthorization_required: true } : {}),
            }
        })
        await this.onAuthorizationRequired?.({
            serverName: this.serverName,
            serverUrl: this.serverUrl,
            reauthorization,
        })

        Logger.log(`[McpOAuth] OAuth required for ${this.serverName} - user must click Authenticate button`)
    }

    async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
        if (scope === "discovery") return

        let invalidated = false
        updateServerSecrets(this.serverHash, (current) => {
            if (
                (scope === "all" || scope === "client") &&
                this.lastClientIdRead !== undefined &&
                current.client_info?.client_id !== this.lastClientIdRead
            ) {
                return current
            }
            if (scope === "tokens" && this.lastTokensRead !== undefined && !sameTokens(current.tokens, this.lastTokensRead)) {
                return current
            }

            const next = { ...current }
            if (scope === "all" || scope === "client") {
                delete next.client_info
                delete next.redirect_url_at_registration
                delete next.tokens
                delete next.tokens_saved_at
                delete next.pending_auth_url
                next.reauthorization_required = true
            } else if (scope === "tokens") {
                delete next.tokens
                delete next.tokens_saved_at
                delete next.pending_auth_url
                next.reauthorization_required = true
            }
            if (scope === "all" || scope === "verifier") {
                delete next.code_verifier
            }
            if (scope === "all") {
                delete next.oauth_state
                delete next.oauth_state_timestamp
            }
            invalidated = true
            return next
        })

        if (!invalidated) return
        if (scope === "all" || scope === "client") this.lastClientIdRead = undefined
        if (scope === "all" || scope === "client" || scope === "tokens") this.lastTokensRead = undefined
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        // Called by SDK when starting authorization flow (PKCE)
        // The verifier is used later in finishAuth() to exchange the auth code for tokens
        updateServerSecrets(this.serverHash, (current) => ({ ...current, code_verifier: codeVerifier }))
    }

    async codeVerifier(): Promise<string> {
        // Called by SDK during finishAuth() to retrieve the PKCE verifier
        // Used to prove that the same client that started auth is finishing it
        const verifier = readServerSecrets(this.serverHash)?.code_verifier

        if (!verifier) {
            throw new Error(`No code verifier found for ${this.serverName}`)
        }

        return verifier
    }

    /**
     * Check if provider has valid authentication
     */
    async isAuthenticated(): Promise<boolean> {
        const tokens = await this.tokens()
        return Boolean(tokens?.access_token)
    }

    /**
     * Get the server hash for this provider
     */
    getServerHash(): string {
        return this.serverHash
    }
}

/**
 * Manages OAuth authentication for MCP servers
 * Creates and manages OAuthClientProvider instances and handles token storage
 */
export class McpOAuthManager {
    private providers: Map<string, OAuthClientProvider> = new Map()
    /** Providers still resolving their redirect, so overlapping connects share one provider and its registration. */
    private readonly creatingProviders = new Map<string, Promise<OAuthClientProvider>>()
    private readonly loopback = new McpOAuthLoopback()
    private readonly activeFlows = new Map<string, { coordinator: LocalOAuthFlowCoordinator<OAuthTokens>; flowId: string }>()
    /**
     * The latest coordinator per server, kept after its flow settles. A settled
     * flow may still be closing its callback server, and the next flow binds the
     * same registered port, so it waits for that release first.
     */
    private readonly lastCoordinators = new Map<string, LocalOAuthFlowCoordinator<OAuthTokens>>()
    private readonly leaseFor: (serverHash: string) => OAuthFlowLease
    private readonly openBrowser: (url: string) => Promise<void>
    private readonly onAuthorizationRequired: McpOAuthManagerOptions["onAuthorizationRequired"]

    /**
     * @param exchangeCode - Redeems a code on the server's transport once the shared coordinator received it.
     */
    constructor(
        private readonly exchangeCode: McpOAuthCodeExchange,
        options: McpOAuthManagerOptions = {},
    ) {
        this.leaseFor =
            options.leaseFor ??
            ((serverHash) => new FileOAuthFlowLease(path.join(getDlineDataDir(), "oauth", "mcp", `${serverHash}.json`)))
        this.openBrowser = options.openExternal ?? openExternal
        this.onAuthorizationRequired = options.onAuthorizationRequired
    }

    /**
     * Gets or creates an OAuthClientProvider for a server
     * Note: This is async now because we need to initialize the redirect URL
     */
    async getOrCreateProvider(serverName: string, serverUrl: string): Promise<OAuthClientProvider> {
        const key = providerKey(serverName, serverUrl)
        const existing = this.providers.get(key)
        if (existing) {
            return existing
        }
        let creating = this.creatingProviders.get(key)
        if (!creating) {
            creating = this.createProvider(serverName, serverUrl, key).finally(() => this.creatingProviders.delete(key))
            this.creatingProviders.set(key, creating)
        }
        return creating
    }

    /**
     * Validates and clears the state of an authorization whose callback came through the URI handler.
     *
     * Only the host-callback path (VS Code Web) uses it; loopback flows are validated by the shared coordinator.
     */
    validateAndClearState(serverHash: string, state: string): boolean {
        const serverData = readServerSecrets(serverHash)

        if (!serverData?.oauth_state) {
            Logger.error(`No stored state found for server hash: ${serverHash}`)
            return false
        }

        const expired =
            serverData.oauth_state_timestamp !== undefined &&
            Date.now() - serverData.oauth_state_timestamp > AUTHORIZATION_TIMEOUT_MS
        const isValid = !expired && serverData.oauth_state === state

        // A state is good for one callback only, whatever its outcome.
        updateServerSecrets(serverHash, (current) => {
            const next = { ...current }
            delete next.oauth_state
            delete next.oauth_state_timestamp
            return next
        })

        if (expired) {
            Logger.error(`OAuth state expired for server hash: ${serverHash}`)
        }
        return isValid
    }

    /**
     * Starts the authorization the user asked for with "Authenticate".
     *
     * The URL comes from redirectToAuthorization(), stored when the SDK found the server needs OAuth.
     * A loopback redirect runs on the shared OAuth coordinator and returns its flow; a host callback
     * (VS Code Web) opens the URL with a fresh state and completes through the URI handler.
     *
     * @param serverDisplayName Name the user sees for the server, used on the browser result page and in errors.
     */
    async startOAuthFlow(
        serverName: string,
        serverUrl: string,
        serverDisplayName: string = serverName,
    ): Promise<McpOAuthFlow | undefined> {
        const serverHash = getServerAuthHash(serverName, serverUrl)
        const sdkAuthorizationUrl = readServerSecrets(serverHash)?.pending_auth_url
        if (!sdkAuthorizationUrl) {
            // The SDK has not been triggered yet, e.g. the server was just added and has not connected.
            throw new McpOAuthAuthorizationNotPreparedError(
                `No pending authorization URL found for ${serverDisplayName}. Please try restarting the server first.`,
            )
        }

        const provider = this.providers.get(providerKey(serverName, serverUrl))
        if (!provider?.redirectUrl || !this.loopback.owns(serverHash)) {
            await this.openWithFreshState(serverHash, sdkAuthorizationUrl)
            return undefined
        }
        return this.startLoopbackFlow({ serverName, serverUrl, serverDisplayName, serverHash, provider, sdkAuthorizationUrl })
    }

    /**
     * Prepare a user-requested recovery when an HTTP 401 arrived after the SDK believed authentication succeeded.
     * Invalidation uses the credential identity observed by the failed request; it must not adopt and delete a newer
     * cross-window rotation that arrived after that 401.
     */
    async prepareReauthorization(serverName: string, serverUrl: string): Promise<void> {
        if (!this.hasSavedTokens(serverName, serverUrl)) return
        const provider = await this.getOrCreateProvider(serverName, serverUrl)
        await provider.invalidateCredentials?.("tokens")
    }

    /** Whether an invalid saved credential explicitly requires the user to authorize again. */
    isReauthorizationRequired(serverName: string, serverUrl: string): boolean {
        return readServerSecrets(getServerAuthHash(serverName, serverUrl))?.reauthorization_required === true
    }

    /** Whether the shared store still contains a token for this server, including an expired one. */
    hasSavedTokens(serverName: string, serverUrl: string): boolean {
        return readServerSecrets(getServerAuthHash(serverName, serverUrl))?.tokens !== undefined
    }

    /**
     * Clears all OAuth data for a server (used when server is deleted)
     */
    async clearServerAuth(serverName: string, serverUrl: string): Promise<void> {
        const serverHash = getServerAuthHash(serverName, serverUrl)

        await this.cancelActiveFlow(serverHash)
        this.forgetRedirect(serverName, serverUrl, serverHash)

        // Clear all OAuth-related data for this server
        deleteMcpOAuthServer(serverHash)
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.activeFlows.keys()].map((serverHash) => this.cancelActiveFlow(serverHash)))
        await Promise.all([...this.lastCoordinators.values()].map((coordinator) => coordinator.dispose()))
        this.lastCoordinators.clear()
        this.loopback.clear()
    }

    private async createProvider(serverName: string, serverUrl: string, key: string): Promise<OAuthClientProvider> {
        const provider = new DlineOAuthClientProvider(serverName, serverUrl, this.loopback, this.onAuthorizationRequired)
        await provider.initialize() // Sets the redirect URL
        this.providers.set(key, provider)
        return provider
    }

    private async startLoopbackFlow(target: {
        serverName: string
        serverUrl: string
        serverDisplayName: string
        serverHash: string
        provider: OAuthClientProvider
        sdkAuthorizationUrl: string
    }): Promise<McpOAuthFlow> {
        const { serverName, serverUrl, serverDisplayName, serverHash, provider, sdkAuthorizationUrl } = target
        const strategy = new McpOAuthFlowStrategy({
            serverHash,
            serverDisplayName,
            redirectUrl: String(provider.redirectUrl),
            sdkAuthorizationUrl,
            exchange: async (code, codeVerifier) => {
                // The SDK's finishAuth reads the verifier back through the provider.
                await provider.saveCodeVerifier(codeVerifier)
                await this.exchangeCode(serverHash, code)
                const tokens = await provider.tokens()
                if (!tokens) {
                    throw new Error(`The authorization server returned no tokens for MCP server "${serverDisplayName}".`)
                }
                return tokens
            },
        })
        if (!strategy.matchesRegisteredRedirect()) {
            this.forgetRedirect(serverName, serverUrl, serverHash)
            throw new McpOAuthReregistrationRequiredError(
                `The authorization request for MCP server "${serverDisplayName}" was built for an earlier callback. Dline is registering again; click Authenticate once it asks for authentication.`,
            )
        }

        await this.cancelActiveFlow(serverHash)
        await this.lastCoordinators.get(serverHash)?.dispose()
        const coordinator = new LocalOAuthFlowCoordinator(strategy, {
            lease: this.leaseFor(serverHash),
            openExternal: this.openBrowser,
            timeoutMs: AUTHORIZATION_TIMEOUT_MS,
        })
        this.lastCoordinators.set(serverHash, coordinator)
        let started: Awaited<ReturnType<typeof coordinator.startFlow>>
        try {
            started = await coordinator.startFlow({ profileId: serverHash })
        } catch (error) {
            if (!isCallbackPortInUse(error)) {
                throw error
            }
            this.forgetRedirect(serverName, serverUrl, serverHash)
            throw new McpOAuthReregistrationRequiredError(
                `The OAuth callback port ${strategy.callbackPort} for MCP server "${serverDisplayName}" is in use by another program. Dline is registering a new callback; click Authenticate again.`,
            )
        }

        const active = { coordinator, flowId: started.flowId }
        this.activeFlows.set(serverHash, active)
        const result = started.result.then(() => undefined)
        void result
            .catch(() => undefined)
            .finally(() => {
                if (this.activeFlows.get(serverHash) === active) {
                    this.activeFlows.delete(serverHash)
                }
            })
        if (started.browserOpenStatus === "failed") {
            await this.cancelActiveFlow(serverHash)
            throw new Error(`Could not open the browser to authorize MCP server "${serverName}".`)
        }
        return { result }
    }

    /** Host-callback path: a fresh state per click, so a retry never reuses a consumed one. */
    private async openWithFreshState(serverHash: string, sdkAuthorizationUrl: string): Promise<void> {
        const authorizationUrl = new URL(sdkAuthorizationUrl)
        const state = crypto.randomBytes(32).toString("hex")
        authorizationUrl.searchParams.set("state", state)

        updateServerSecrets(serverHash, (current) => ({ ...current, oauth_state: state, oauth_state_timestamp: Date.now() }))

        await this.openBrowser(authorizationUrl.toString())
    }

    private async cancelActiveFlow(serverHash: string): Promise<void> {
        const active = this.activeFlows.get(serverHash)
        if (!active) {
            return
        }
        this.activeFlows.delete(serverHash)
        await active.coordinator.cancelFlow({ flowId: active.flowId, profileId: serverHash }).catch(() => undefined)
    }

    /** Drops the cached provider and its reserved port, so the next connection resolves and registers a redirect again. */
    private forgetRedirect(serverName: string, serverUrl: string, serverHash: string): void {
        this.providers.delete(providerKey(serverName, serverUrl))
        this.loopback.release(serverHash)
    }
}

function providerKey(serverName: string, serverUrl: string): string {
    return `${serverName}:${serverUrl}`
}

function tokenIdentity(tokens: OAuthTokens): OAuthTokenIdentity {
    return { accessToken: tokens.access_token, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}) }
}

function sameTokens(current: OAuthTokens | undefined, lastRead: OAuthTokenIdentity | undefined): boolean {
    if (!current || !lastRead) return current === undefined && lastRead === undefined
    return current.access_token === lastRead.accessToken && current.refresh_token === lastRead.refreshToken
}
