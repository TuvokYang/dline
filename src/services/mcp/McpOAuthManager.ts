import path from "node:path"
import { getAllMcpOAuthSecrets, setAllMcpOAuthSecrets } from "@core/storage/secrets"
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

export interface McpOAuthManagerOptions {
    /** Lease that keeps one authorization per server across Dline windows. */
    leaseFor?: (serverHash: string) => OAuthFlowLease
    openExternal?: (url: string) => Promise<void>
}

/** An authorization may take a while when the user has to sign in or create an account first. */
const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Structure for all OAuth data stored in the single mcpOAuthSecrets JSON
 */
interface McpOAuthSecrets {
    [serverHash: string]: {
        tokens?: OAuthTokens
        tokens_saved_at?: number
        client_info?: OAuthClientInformationFull
        redirect_url_at_registration?: string
        code_verifier?: string
        oauth_state?: string
        oauth_state_timestamp?: number
        pending_auth_url?: string
    }
}

/**
 * Helper to read OAuth secrets from storage
 */
function getMcpOAuthSecrets(): McpOAuthSecrets {
    return getAllMcpOAuthSecrets() as McpOAuthSecrets
}

/**
 * Helper to save OAuth secrets to storage
 */
function saveMcpOAuthSecrets(secrets: McpOAuthSecrets): void {
    setAllMcpOAuthSecrets(secrets)
}

/**
 * Implementation of OAuthClientProvider for Dline
 * Manages OAuth state and token storage for a single MCP server
 */
class DlineOAuthClientProvider implements OAuthClientProvider {
    private serverName: string
    private serverUrl: string
    private _redirectUrl: string
    private isRegistrationValid: boolean
    private serverHash: string
    private readonly loopback: McpOAuthLoopback

    constructor(serverName: string, serverUrl: string, loopback: McpOAuthLoopback) {
        this.serverName = serverName
        this.serverUrl = serverUrl
        this.serverHash = getServerAuthHash(serverName, serverUrl)
        this.loopback = loopback

        // Redirect URL and registration validity will be set when initialize() is called
        this._redirectUrl = ""
        this.isRegistrationValid = false
    }

    async initialize(): Promise<void> {
        // Get the full callback URL with the MCP server-specific path,
        // attempting to reuse the previously-registered port to preserve the OAuth client registration.
        const callbackPath = getMcpServerCallbackPath(this.serverName, this.serverUrl)
        const secrets = getMcpOAuthSecrets()
        const savedRedirectUrl = secrets[this.serverHash]?.redirect_url_at_registration

        const resolution = await McpOAuthRedirectResolver.resolve(
            savedRedirectUrl,
            callbackPath,
            this.loopback.callbackUrlSource(this.serverHash, HostProvider.get().getCallbackUrl),
        )

        this._redirectUrl = resolution.redirectUrl
        this.isRegistrationValid = resolution.isRegistrationValid
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

    async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
        // If the redirect URL has changed since the client was registered
        // (e.g., different port bound, platform migration), the saved client_info
        // is stale — the OAuth server will reject requests with the old redirect_uri.
        // Return undefined to force the SDK to re-register a new client.
        if (!this.isRegistrationValid) {
            const secrets = getMcpOAuthSecrets()
            if (secrets[this.serverHash]?.client_info) {
                Logger.log(`[McpOAuth] Discarding stale client registration for ${this.serverName} — redirect URL changed`)
                // Clear the stale client_info and tokens (tokens are bound to the old client_id)
                delete secrets[this.serverHash].client_info
                delete secrets[this.serverHash].redirect_url_at_registration
                delete secrets[this.serverHash].tokens
                delete secrets[this.serverHash].tokens_saved_at
                saveMcpOAuthSecrets(secrets)
            }
            return undefined
        }

        const secrets = getMcpOAuthSecrets()
        return secrets[this.serverHash]?.client_info
    }

    async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
        const secrets = getMcpOAuthSecrets()
        if (!secrets[this.serverHash]) {
            secrets[this.serverHash] = {}
        }
        secrets[this.serverHash].client_info = clientInformation
        // Track the redirect URL used for this registration so we can detect
        // when it changes and force re-registration (see clientInformation())
        secrets[this.serverHash].redirect_url_at_registration = this._redirectUrl
        saveMcpOAuthSecrets(secrets)

        // After a successful registration, the current redirect URL is now the registered one
        this.isRegistrationValid = true
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

        const secrets = getMcpOAuthSecrets()
        const serverData = secrets[this.serverHash]

        if (!serverData?.tokens) {
            return undefined
        }

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

        const secrets = getMcpOAuthSecrets()
        if (!secrets[this.serverHash]) {
            secrets[this.serverHash] = {}
        }

        secrets[this.serverHash].tokens = tokens
        secrets[this.serverHash].tokens_saved_at = Date.now()
        saveMcpOAuthSecrets(secrets)
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

        // Guard: Check if we already have valid tokens
        // If tokens exist, this method shouldn't be called (SDK would use them)
        // But if it is called, don't overwrite existing auth state
        const existingTokens = await this.tokens()
        if (existingTokens?.access_token) {
            Logger.warn(`[McpOAuth] Preserving existing tokens for ${this.serverName}`)
            return
        }

        // Keep the SDK-built URL (endpoint, client_id, redirect_uri, scope, resource) for the
        // Authenticate click; state is created per click so a retry never reuses a consumed one.
        const secrets = getMcpOAuthSecrets()
        if (!secrets[this.serverHash]) {
            secrets[this.serverHash] = {}
        }

        secrets[this.serverHash].pending_auth_url = authorizationUrl.toString()
        saveMcpOAuthSecrets(secrets)

        Logger.log(`[McpOAuth] OAuth required for ${this.serverName} - user must click Authenticate button`)
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        // Called by SDK when starting authorization flow (PKCE)
        // The verifier is used later in finishAuth() to exchange the auth code for tokens
        const secrets = getMcpOAuthSecrets()
        if (!secrets[this.serverHash]) {
            secrets[this.serverHash] = {}
        }
        secrets[this.serverHash].code_verifier = codeVerifier
        saveMcpOAuthSecrets(secrets)
    }

    async codeVerifier(): Promise<string> {
        // Called by SDK during finishAuth() to retrieve the PKCE verifier
        // Used to prove that the same client that started auth is finishing it
        const secrets = getMcpOAuthSecrets()
        const verifier = secrets[this.serverHash]?.code_verifier

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
    private readonly loopback = new McpOAuthLoopback()
    private readonly activeFlows = new Map<string, { coordinator: LocalOAuthFlowCoordinator<OAuthTokens>; flowId: string }>()
    private readonly leaseFor: (serverHash: string) => OAuthFlowLease
    private readonly openBrowser: (url: string) => Promise<void>

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
    }

    /**
     * Gets or creates an OAuthClientProvider for a server
     * Note: This is async now because we need to initialize the redirect URL
     */
    async getOrCreateProvider(serverName: string, serverUrl: string): Promise<OAuthClientProvider> {
        const key = providerKey(serverName, serverUrl)
        if (this.providers.has(key)) {
            return this.providers.get(key)!
        }

        // Create provider
        const provider = new DlineOAuthClientProvider(serverName, serverUrl, this.loopback)
        await provider.initialize() // Sets the redirect URL
        this.providers.set(key, provider)
        return provider
    }

    /**
     * Validates and clears the state of an authorization whose callback came through the URI handler.
     *
     * Only the host-callback path (VS Code Web) uses it; loopback flows are validated by the shared coordinator.
     */
    validateAndClearState(serverHash: string, state: string): boolean {
        const secrets = getMcpOAuthSecrets()
        const serverData = secrets[serverHash]

        if (!serverData?.oauth_state) {
            Logger.error(`No stored state found for server hash: ${serverHash}`)
            return false
        }

        if (serverData.oauth_state_timestamp && Date.now() - serverData.oauth_state_timestamp > AUTHORIZATION_TIMEOUT_MS) {
            Logger.error(`OAuth state expired for server hash: ${serverHash}`)
            delete serverData.oauth_state
            delete serverData.oauth_state_timestamp
            saveMcpOAuthSecrets(secrets)
            return false
        }

        const isValid = serverData.oauth_state === state

        // Clear state after validation
        delete serverData.oauth_state
        delete serverData.oauth_state_timestamp
        saveMcpOAuthSecrets(secrets)

        return isValid
    }

    /**
     * Starts the authorization the user asked for with "Authenticate".
     *
     * The URL comes from redirectToAuthorization(), stored when the SDK found the server needs OAuth.
     * A loopback redirect runs on the shared OAuth coordinator and returns its flow; a host callback
     * (VS Code Web) opens the URL with a fresh state and completes through the URI handler.
     */
    async startOAuthFlow(serverName: string, serverUrl: string): Promise<McpOAuthFlow | undefined> {
        const serverHash = getServerAuthHash(serverName, serverUrl)
        const sdkAuthorizationUrl = getMcpOAuthSecrets()[serverHash]?.pending_auth_url
        if (!sdkAuthorizationUrl) {
            // The SDK has not been triggered yet, e.g. the server was just added and has not connected.
            throw new Error(`No pending authorization URL found for ${serverName}. Please try restarting the server first.`)
        }

        const provider = this.providers.get(providerKey(serverName, serverUrl))
        if (!provider?.redirectUrl || !this.loopback.owns(serverHash)) {
            await this.openWithFreshState(serverHash, sdkAuthorizationUrl)
            return undefined
        }
        return this.startLoopbackFlow({ serverName, serverUrl, serverHash, provider, sdkAuthorizationUrl })
    }

    /**
     * Clears all OAuth data for a server (used when server is deleted)
     */
    async clearServerAuth(serverName: string, serverUrl: string): Promise<void> {
        const serverHash = getServerAuthHash(serverName, serverUrl)

        await this.cancelActiveFlow(serverHash)
        this.forgetRedirect(serverName, serverUrl, serverHash)

        // Clear all OAuth-related data for this server
        const secrets = getMcpOAuthSecrets()
        delete secrets[serverHash]
        saveMcpOAuthSecrets(secrets)
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.activeFlows.keys()].map((serverHash) => this.cancelActiveFlow(serverHash)))
        this.loopback.clear()
    }

    private async startLoopbackFlow(target: {
        serverName: string
        serverUrl: string
        serverHash: string
        provider: OAuthClientProvider
        sdkAuthorizationUrl: string
    }): Promise<McpOAuthFlow> {
        const { serverName, serverUrl, serverHash, provider, sdkAuthorizationUrl } = target
        const strategy = new McpOAuthFlowStrategy({
            serverHash,
            serverName,
            redirectUrl: String(provider.redirectUrl),
            sdkAuthorizationUrl,
            exchange: async (code, codeVerifier) => {
                // The SDK's finishAuth reads the verifier back through the provider.
                await provider.saveCodeVerifier(codeVerifier)
                await this.exchangeCode(serverHash, code)
                const tokens = await provider.tokens()
                if (!tokens) {
                    throw new Error(`The authorization server returned no tokens for MCP server "${serverName}".`)
                }
                return tokens
            },
        })
        if (!strategy.matchesRegisteredRedirect()) {
            this.forgetRedirect(serverName, serverUrl, serverHash)
            throw new McpOAuthReregistrationRequiredError(
                `The authorization request for MCP server "${serverName}" was built for an earlier callback. Dline is registering again; click Authenticate once it asks for authentication.`,
            )
        }

        await this.cancelActiveFlow(serverHash)
        const coordinator = new LocalOAuthFlowCoordinator(strategy, {
            lease: this.leaseFor(serverHash),
            openExternal: this.openBrowser,
            timeoutMs: AUTHORIZATION_TIMEOUT_MS,
        })
        let started: Awaited<ReturnType<typeof coordinator.startFlow>>
        try {
            started = await coordinator.startFlow({ profileId: serverHash })
        } catch (error) {
            if (!isCallbackPortInUse(error)) {
                throw error
            }
            this.forgetRedirect(serverName, serverUrl, serverHash)
            throw new McpOAuthReregistrationRequiredError(
                `The OAuth callback port ${strategy.callbackPort} for MCP server "${serverName}" is in use by another program. Dline is registering a new callback; click Authenticate again.`,
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

        const secrets = getMcpOAuthSecrets()
        secrets[serverHash] ??= {}
        secrets[serverHash].oauth_state = state
        secrets[serverHash].oauth_state_timestamp = Date.now()
        saveMcpOAuthSecrets(secrets)

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
