import {
	type ClaudeCodeOAuthCredentials,
	ClaudeCodeProfileAuthRepository,
} from "@/core/storage/secrets/ClaudeCodeProfileAuthRepository"
import { ClaudeCodeOAuthTokenError, isClaudeCodeCredentialExpired } from "./oauth-strategy"

export type ClaudeCodeAuthStatus = "missing" | "malformed" | "authenticated" | "refreshable_expired" | "unusable_expired"

export interface ClaudeCodeRefreshStrategy {
	refreshCredential(credential: ClaudeCodeOAuthCredentials): Promise<ClaudeCodeOAuthCredentials>
}

export interface ClaudeCodeProfileSessionRegistryOptions {
	repository: ClaudeCodeProfileAuthRepository
	strategy: ClaudeCodeRefreshStrategy
	now?: () => number
}

/**
 * Resolves a usable access token for one API Profile.
 *
 * Refresh is coalesced per Profile: several concurrent requests on the same
 * Profile would otherwise each redeem the refresh token, and a provider that
 * rotates refresh tokens invalidates every attempt but the first.
 */
export class ClaudeCodeProfileSessionRegistry {
	private readonly repository: ClaudeCodeProfileAuthRepository
	private readonly strategy: ClaudeCodeRefreshStrategy
	private readonly now: () => number
	private readonly inFlightRefreshes = new Map<string, Promise<ClaudeCodeOAuthCredentials>>()

	constructor(options: ClaudeCodeProfileSessionRegistryOptions) {
		this.repository = options.repository
		this.strategy = options.strategy
		this.now = options.now ?? Date.now
	}

	async getStatus(profileId: string): Promise<ClaudeCodeAuthStatus> {
		const stored = await this.repository.read(profileId)
		if (stored.status !== "valid") return stored.status
		if (!isClaudeCodeCredentialExpired(stored.credential, this.now())) return "authenticated"
		return stored.credential.refresh_token ? "refreshable_expired" : "unusable_expired"
	}

	/**
	 * Return a non-expired access token, refreshing it when required.
	 *
	 * @throws ClaudeCodeOAuthTokenError when the Profile has no usable
	 * credential, so the caller surfaces a sign-in prompt instead of sending a
	 * request that is certain to fail.
	 */
	async getAccessToken(profileId: string): Promise<string> {
		return (await this.getCredential(profileId)).access_token
	}

	async getCredential(profileId: string): Promise<ClaudeCodeOAuthCredentials> {
		const stored = await this.repository.read(profileId)
		if (stored.status === "missing") {
			throw new ClaudeCodeOAuthTokenError("REFRESH_TOKEN_UNAVAILABLE", "This profile is not signed in to Claude Code.")
		}
		if (stored.status === "malformed") {
			throw new ClaudeCodeOAuthTokenError(
				"INVALID_TOKEN_RESPONSE",
				"The stored Claude Code credential could not be read. Sign in again.",
			)
		}
		if (!isClaudeCodeCredentialExpired(stored.credential, this.now())) return stored.credential
		return this.refresh(profileId, stored.credential)
	}

	/**
	 * Refresh after upstream rejected the current token.
	 *
	 * The expiry check cannot see a token revoked early, so this exists as an
	 * explicit recovery entry point for a 401 response.
	 */
	async forceRefresh(profileId: string): Promise<ClaudeCodeOAuthCredentials> {
		const stored = await this.repository.read(profileId)
		if (stored.status !== "valid") {
			throw new ClaudeCodeOAuthTokenError("REFRESH_TOKEN_UNAVAILABLE", "This profile is not signed in to Claude Code.")
		}
		return this.refresh(profileId, stored.credential)
	}

	private refresh(profileId: string, current: ClaudeCodeOAuthCredentials): Promise<ClaudeCodeOAuthCredentials> {
		const pending = this.inFlightRefreshes.get(profileId)
		if (pending) return pending

		const refresh = this.exchangeAndPersist(profileId, current).finally(() => {
			this.inFlightRefreshes.delete(profileId)
		})
		this.inFlightRefreshes.set(profileId, refresh)
		return refresh
	}

	private async exchangeAndPersist(
		profileId: string,
		current: ClaudeCodeOAuthCredentials,
	): Promise<ClaudeCodeOAuthCredentials> {
		if (!current.refresh_token) {
			throw new ClaudeCodeOAuthTokenError(
				"REFRESH_TOKEN_UNAVAILABLE",
				"The Claude Code credential expired and cannot be refreshed. Sign in again.",
			)
		}
		const refreshed = await this.strategy.refreshCredential(current)
		const outcome = await this.repository.replaceIfMatches(profileId, current, refreshed)
		// Another window refreshed first. Its credential is the durable one, and
		// this one may already be invalidated by rotation.
		if (outcome === "changed") {
			const latest = await this.repository.read(profileId)
			if (latest.status === "valid") return latest.credential
		}
		if (outcome === "missing") {
			throw new ClaudeCodeOAuthTokenError("REFRESH_TOKEN_UNAVAILABLE", "This profile was signed out during the refresh.")
		}
		return refreshed
	}
}
