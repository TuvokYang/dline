/**
 * Claude Code `GET /v1/models` for one subscription Profile.
 *
 * The listing wire format is Anthropic's, so pagination and capability parsing
 * are inherited. What differs is the credential: a subscription has no API key,
 * so the request carries the Profile's OAuth access token plus the Claude Code
 * client identity, and upstream rejects the token without the OAuth beta.
 */
import { claudeCodeDefaultModelId } from "@core/api/providers/models/claude-code"
import { CLAUDE_CODE_OAUTH_BETA } from "@integrations/anthropic-claude-code/beta-headers"
import { buildClaudeCodeClientHeaders } from "@integrations/anthropic-claude-code/client-headers"
import { getClaudeCodeProfileSessionRegistry } from "@integrations/anthropic-claude-code/registry"
import type { ModelInfo } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import type { ProviderRemoteContext } from "../model-source"
import { AnthropicModelSource } from "./anthropic"
import { getClaudeCodeClientVersionResolver } from "./claude-code-client-version"

const ANTHROPIC_VERSION = "2023-06-01"

/** Resolves the client version declared to upstream for a listing request. */
export interface ClaudeCodeListingClientVersionSource {
	resolve(signal?: AbortSignal): Promise<{ readonly version: string }>
}

export class ClaudeCodeModelSource extends AnthropicModelSource {
	override readonly providerId = "claude-code"
	override readonly providerName = "Claude Code"
	override readonly billingMode = "subscription"
	/** The listing supplements the built-in catalog, which owns aliases and pricing. */
	override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
	/** A subscription authenticates with an OAuth token rather than an API key. */
	override readonly requiresApiKey = false
	override readonly preferredDefaultModelId = claudeCodeDefaultModelId

	constructor(
		private readonly sessionRegistry = getClaudeCodeProfileSessionRegistry(),
		private readonly clientVersionSource: ClaudeCodeListingClientVersionSource = getClaudeCodeClientVersionResolver(),
	) {
		super()
	}

	override async fetchModels(context: ProviderRemoteContext): Promise<Record<string, ModelInfo>> {
		const profileId = context.profileId?.trim()
		if (!profileId) {
			Logger.debug("[ClaudeCodeModelSource] Listing skipped: Profile identity is missing")
			return {}
		}

		let accessToken: string
		try {
			accessToken = await this.sessionRegistry.getAccessToken(profileId)
		} catch (error) {
			// A signed-out Profile is an expected state for a settings refresh,
			// not a listing failure worth surfacing as an error.
			Logger.debug(`[ClaudeCodeModelSource] Listing skipped: ${error instanceof Error ? error.message : String(error)}`)
			return {}
		}

		const { version } = await this.clientVersionSource.resolve(context.signal)

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await super.fetchModels({
					...context,
					profileId,
					apiKey: accessToken,
					vendorCredentials: { clientVersion: version },
				})
			} catch (error) {
				const unauthorized = error instanceof Error && /status 401\b/.test(error.message)
				if (!unauthorized || attempt > 0) throw error
				// The stored token can be revoked before it expires, so one
				// refresh separates a stale credential from a real rejection.
				Logger.debug("[ClaudeCodeModelSource] Listing received 401; refreshing the Profile OAuth credential")
				accessToken = (await this.sessionRegistry.forceRefresh(profileId)).access_token
			}
		}
		return {}
	}

	protected override buildHeaders(context: ProviderRemoteContext): Record<string, string> {
		const clientVersion = context.vendorCredentials?.clientVersion
		return {
			...(clientVersion ? buildClaudeCodeClientHeaders(clientVersion) : {}),
			Accept: "application/json",
			"anthropic-version": ANTHROPIC_VERSION,
			"anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
			...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}),
		}
	}
}

export const claudeCodeModelSource = new ClaudeCodeModelSource()
