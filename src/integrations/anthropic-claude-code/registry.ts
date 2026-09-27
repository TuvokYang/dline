import { ClaudeCodeProfileAuthRepository } from "@/core/storage/secrets/ClaudeCodeProfileAuthRepository"
import { ClaudeCodeOAuthStrategy } from "./oauth-strategy"
import { ClaudeCodeProfileSessionRegistry } from "./session"

let sessionRegistry: ClaudeCodeProfileSessionRegistry | undefined
let authRepository: ClaudeCodeProfileAuthRepository | undefined
let oauthStrategy: ClaudeCodeOAuthStrategy | undefined

/**
 * Process-wide Claude Code OAuth composition.
 *
 * Refresh coalescing is per registry instance, so every consumer in this
 * process must share one: two registries would each redeem the refresh token
 * and, with rotation, invalidate one another.
 */
export function getClaudeCodeProfileAuthRepository(): ClaudeCodeProfileAuthRepository {
	authRepository ??= new ClaudeCodeProfileAuthRepository()
	return authRepository
}

export function getClaudeCodeOAuthStrategy(): ClaudeCodeOAuthStrategy {
	oauthStrategy ??= new ClaudeCodeOAuthStrategy()
	return oauthStrategy
}

export function getClaudeCodeProfileSessionRegistry(): ClaudeCodeProfileSessionRegistry {
	sessionRegistry ??= new ClaudeCodeProfileSessionRegistry({
		repository: getClaudeCodeProfileAuthRepository(),
		strategy: getClaudeCodeOAuthStrategy(),
	})
	return sessionRegistry
}

/** Resets the shared composition. Intended for tests that isolate storage roots. */
export function resetClaudeCodeOAuthRegistryForTesting(): void {
	sessionRegistry = undefined
	authRepository = undefined
	oauthStrategy = undefined
}
