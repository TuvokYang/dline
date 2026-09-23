import { randomUUID } from "node:crypto"
import path from "node:path"
import { getDlineDataDir } from "@/core/storage/disk"
import type { ClaudeCodeOAuthCredentials } from "@/core/storage/secrets/ClaudeCodeProfileAuthRepository"
import {
	type CompleteOAuthPastedValueInput,
	FileOAuthFlowLease,
	LocalOAuthFlowCoordinator,
	OAuthFlowError,
	type OAuthFlowLease,
} from "@/services/oauth"
import { openExternal } from "@/utils/env"
import { getClaudeCodeOAuthStrategy, getClaudeCodeProfileAuthRepository, getClaudeCodeProfileSessionRegistry } from "./registry"
import type { ClaudeCodeAuthStatus } from "./session"

/** Account labels safe to render; no token or account id is exposed. */
export interface ClaudeCodeAccountIdentity {
	displayName?: string
	email?: string
	organizationName?: string
	expiresAtMs?: number
}

export interface ClaudeCodeAuthorizationFlow {
	profileId: string
	flowId: string
	/** URL opened in the browser; loopback when available, hosted otherwise. */
	authorizationUrl: string
	/** Hosted-page URL that yields a copyable code, when the strategy offers one. */
	manualAuthorizationUrl?: string
	expiresAtMs: number
	browserOpenStatus: "opened" | "failed"
	/** False when no loopback port could be bound, so only the paste path works. */
	loopbackListening: boolean
}

export interface ClaudeCodeOAuthManagerOptions {
	lease?: OAuthFlowLease
	openExternal?: (authorizationUrl: string) => Promise<void>
	timeoutMs?: number
}

/**
 * Profile-targeted Claude Code OAuth application service.
 *
 * Credential storage and refresh belong to the session registry; this type owns
 * only the interactive sign-in lifecycle and the projection the UI renders.
 */
export class ClaudeCodeOAuthManager {
	private readonly coordinator: LocalOAuthFlowCoordinator<ClaudeCodeOAuthCredentials>
	private activeFlow: ClaudeCodeAuthorizationFlow | undefined

	constructor(options: ClaudeCodeOAuthManagerOptions = {}) {
		this.coordinator = new LocalOAuthFlowCoordinator(getClaudeCodeOAuthStrategy(), {
			lease: options.lease ?? new FileOAuthFlowLease(path.join(getDlineDataDir(), "oauth", "local-oauth-flow.json")),
			openExternal: options.openExternal ?? openExternal,
			onCredential: ({ profileId, credential }) => getClaudeCodeProfileAuthRepository().save(profileId, credential),
			timeoutMs: options.timeoutMs,
		})
	}

	async getAuthStatus(profileId: string): Promise<ClaudeCodeAuthStatus> {
		return getClaudeCodeProfileSessionRegistry().getStatus(profileId)
	}

	/** Reads the stored credential for display without triggering a refresh. */
	async getAccount(profileId: string): Promise<ClaudeCodeAccountIdentity | null> {
		const stored = await getClaudeCodeProfileAuthRepository().read(profileId)
		if (stored.status !== "valid") return null
		const { displayName, email, organizationName, expires } = stored.credential
		if (!displayName && !email && !organizationName) return { expiresAtMs: expires }
		return {
			...(displayName ? { displayName } : {}),
			...(email ? { email } : {}),
			...(organizationName ? { organizationName } : {}),
			expiresAtMs: expires,
		}
	}

	getActiveAuthorizationFlow(profileId: string): ClaudeCodeAuthorizationFlow | undefined {
		return this.activeFlow?.profileId === profileId ? this.activeFlow : undefined
	}

	async startAuthorizationFlow(profileId: string): Promise<ClaudeCodeAuthorizationFlow> {
		if (this.activeFlow) {
			throw new OAuthFlowError("FLOW_ALREADY_IN_PROGRESS", "An OAuth authorization flow is already active.")
		}
		const flowId = randomUUID()
		const started = await this.coordinator.startFlow({ profileId, flowId })
		const flow: ClaudeCodeAuthorizationFlow = {
			profileId,
			flowId: started.flowId,
			authorizationUrl: started.authorizationUrl,
			...(started.manualAuthorizationUrl ? { manualAuthorizationUrl: started.manualAuthorizationUrl } : {}),
			expiresAtMs: started.expiresAtMs,
			browserOpenStatus: started.browserOpenStatus,
			loopbackListening: started.loopbackListening,
		}
		this.activeFlow = flow
		// The loopback callback can also settle the flow, so clearing the active
		// flow is bound to the result rather than to the explicit completion call.
		void started.result
			.catch(() => undefined)
			.finally(() => {
				if (this.activeFlow?.flowId === flow.flowId) this.activeFlow = undefined
			})
		return flow
	}

	/** Completes from either a pasted callback URL or a pasted authorization code. */
	async completeFromPastedValue(input: CompleteOAuthPastedValueInput): Promise<void> {
		await this.coordinator.completeFromPastedValue(input)
	}

	async cancelAuthorizationFlow(profileId: string, flowId?: string): Promise<void> {
		const target = flowId ?? this.getActiveAuthorizationFlow(profileId)?.flowId
		if (!target) return
		try {
			await this.coordinator.cancelFlow({ profileId, flowId: target })
		} catch (error) {
			// A flow that already ended needs no cancellation; anything else is real.
			if (!(error instanceof OAuthFlowError) || (error.code !== "FLOW_NOT_FOUND" && error.code !== "FLOW_TIMED_OUT")) {
				throw error
			}
		} finally {
			if (this.activeFlow?.flowId === target) this.activeFlow = undefined
		}
	}

	async signOut(profileId: string): Promise<void> {
		await this.cancelAuthorizationFlow(profileId)
		await getClaudeCodeProfileAuthRepository().delete(profileId)
	}

	async dispose(): Promise<void> {
		this.activeFlow = undefined
		await this.coordinator.dispose()
	}
}

export const claudeCodeOAuthManager = new ClaudeCodeOAuthManager()
