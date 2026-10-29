import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type {
    LocalOAuthCallbackPages,
    OAuthAuthorizationInput,
    OAuthAuthorizationStrategy,
    OAuthCodeExchangeInput,
} from "@/services/oauth"
import { mcpOAuthCallbackPages } from "./McpOAuthLoopback"

export interface McpOAuthFlowTarget {
    serverHash: string
    /** Name the user sees for the server, shown on the browser result page. */
    serverDisplayName: string
    /** Loopback redirect registered for this server's client. */
    redirectUrl: string
    /**
     * Authorization URL the MCP SDK built when the server connected.
     *
     * It already carries the discovered authorization endpoint, the registered client_id,
     * redirect_uri, scope and resource, so only the PKCE challenge and state are replaced.
     */
    sdkAuthorizationUrl: string
    /** Redeems the code through the MCP SDK with the given PKCE verifier and returns the saved tokens. */
    exchange(code: string, codeVerifier: string): Promise<OAuthTokens>
}

/**
 * Runs one MCP server's authorization on the shared OAuth coordinator.
 *
 * The coordinator owns PKCE, state, the loopback callback and the timeout, as for every other
 * Dline sign-in. The MCP SDK keeps discovery, dynamic client registration, the code exchange and
 * token refresh.
 */
export class McpOAuthFlowStrategy implements OAuthAuthorizationStrategy<OAuthTokens> {
    readonly strategyId: string
    readonly callbackPort: number
    readonly callbackPath: string
    readonly providerDisplayName: string
    readonly callbackPages: LocalOAuthCallbackPages

    constructor(private readonly target: McpOAuthFlowTarget) {
        const redirect = new URL(target.redirectUrl)
        this.strategyId = `mcp:${target.serverHash}`
        this.callbackPort = Number(redirect.port)
        this.callbackPath = redirect.pathname
        this.providerDisplayName = target.serverDisplayName
        this.callbackPages = mcpOAuthCallbackPages(target.serverDisplayName)
    }

    /** Whether the SDK URL was built for the redirect this strategy listens on. */
    matchesRegisteredRedirect(): boolean {
        return new URL(this.target.sdkAuthorizationUrl).searchParams.get("redirect_uri") === this.target.redirectUrl
    }

    buildAuthorizationUrl(input: OAuthAuthorizationInput): URL {
        const url = new URL(this.target.sdkAuthorizationUrl)
        url.searchParams.set("code_challenge", input.codeChallenge)
        url.searchParams.set("code_challenge_method", "S256")
        url.searchParams.set("state", input.state)
        return url
    }

    exchangeAuthorizationCode(input: OAuthCodeExchangeInput): Promise<OAuthTokens> {
        return this.target.exchange(input.code, input.codeVerifier)
    }
}
