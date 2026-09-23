import { timingSafeEqual } from "node:crypto"
import { OAuthFlowError } from "./types"

export interface ParsedOAuthCallback {
	code: string
	/**
	 * Every query parameter the provider returned, including `code` and `state`.
	 *
	 * The framework only validates the parameters OAuth itself defines. Which of
	 * the remaining ones a token endpoint expects back is provider knowledge, so
	 * they are handed to the strategy rather than being interpreted here.
	 */
	params: Readonly<Record<string, string>>
}

/** Loopback names that address the same local callback server. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function safeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left)
	const rightBytes = Buffer.from(right)
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Compares callback origins, treating equivalent loopback hostnames as one origin.
 *
 * The published `redirect_uri` may use `localhost` to satisfy a provider allow-list while the
 * server binds `127.0.0.1`, so the browser can deliver the callback under either name. Scheme
 * and port still have to match exactly.
 */
function isSameCallbackOrigin(callback: URL, expected: URL): boolean {
	if (callback.protocol !== expected.protocol || callback.port !== expected.port) return false
	if (callback.hostname === expected.hostname) return true
	return LOOPBACK_HOSTNAMES.has(callback.hostname) && LOOPBACK_HOSTNAMES.has(expected.hostname)
}

export function parseOAuthCallbackUri(
	callbackUri: string,
	expectedRedirectUri: string,
	expectedState: string,
): ParsedOAuthCallback {
	let callback: URL
	let expected: URL
	try {
		callback = new URL(callbackUri)
		expected = new URL(expectedRedirectUri)
	} catch {
		throw new OAuthFlowError("CALLBACK_URI_INVALID", "The OAuth callback URI is invalid.")
	}

	if (!isSameCallbackOrigin(callback, expected) || callback.pathname !== expected.pathname) {
		throw new OAuthFlowError("CALLBACK_URI_MISMATCH", "The OAuth callback URI does not match the active flow.")
	}

	const state = callback.searchParams.get("state")
	if (!state || !safeEqual(state, expectedState)) {
		throw new OAuthFlowError("STATE_MISMATCH", "The OAuth callback state does not match the active flow.")
	}

	if (callback.searchParams.has("error")) {
		throw new OAuthFlowError("AUTHORIZATION_DENIED", "OAuth authorization was not completed.", true)
	}

	const code = callback.searchParams.get("code")
	if (!code) {
		throw new OAuthFlowError("CALLBACK_MISSING_PARAMETERS", "The OAuth callback is missing an authorization code.")
	}
	return { code, params: Object.freeze(Object.fromEntries(callback.searchParams)) }
}
