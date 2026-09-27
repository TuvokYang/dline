/**
 * Endpoints the Claude Code subscription integration talks to.
 *
 * Production values are the real Anthropic endpoints. An E2E run may redirect
 * them at a loopback mock, which is the only way to exercise the sign-in flow
 * without a real subscription account.
 */
export const CLAUDE_CODE_PRODUCTION_RUNTIME_CONFIG = {
	authorizationEndpoint: "https://claude.com/cai/oauth/authorize",
	tokenEndpoint: "https://platform.claude.com/v1/oauth/token",
	manualRedirectUri: "https://platform.claude.com/oauth/code/callback",
	usageUrl: "https://api.anthropic.com/api/oauth/usage",
} as const

export interface ClaudeCodeRuntimeConfig {
	authorizationEndpoint: string
	tokenEndpoint: string
	manualRedirectUri: string
	usageUrl: string
	callbackPorts?: readonly number[]
	timeoutMs?: number
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * Parse an override that must point at a loopback HTTP endpoint.
 *
 * The override exists for tests, so anything reachable off the machine is
 * rejected: a misconfigured run would otherwise send real credentials, or a
 * real authorization code, to whatever host the variable named.
 */
function loopbackHttpUrl(name: string, value: string): URL {
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		throw new Error(`${name} must be a loopback HTTP URL.`)
	}
	if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
		throw new Error(`${name} must be a loopback HTTP URL.`)
	}
	parsed.hash = ""
	return parsed
}

function normalizedUrl(url: URL): string {
	return url.toString().replace(/\/$/, "")
}

function appendPath(base: URL, segment: string): string {
	const url = new URL(base)
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${segment}`
	url.search = ""
	return normalizedUrl(url)
}

function positiveInteger(name: string, value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`)
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
	return parsed
}

/**
 * Parse the callback port list.
 *
 * Port `0` is allowed and meaningful: it asks the OS for any free port, which
 * is how a test proves the flow still works when the preferred ports are taken.
 */
function callbackPorts(value: string | undefined): readonly number[] | undefined {
	if (value === undefined) return undefined
	const ports = value.split(",").map((port) => {
		const trimmed = port.trim()
		if (!/^\d+$/.test(trimmed)) throw new Error("DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS must contain TCP ports.")
		const parsed = Number(trimmed)
		if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
			throw new Error("DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS must contain TCP ports.")
		}
		return parsed
	})
	if (ports.length === 0) throw new Error("DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS must contain TCP ports.")
	return ports
}

/**
 * Resolve the endpoints for this process.
 *
 * Overrides apply only under `E2E_TEST`, so a stray environment variable in a
 * user's shell cannot redirect production traffic.
 */
export function resolveClaudeCodeRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeCodeRuntimeConfig {
	if (env.E2E_TEST !== "true") return CLAUDE_CODE_PRODUCTION_RUNTIME_CONFIG

	const oauthBase = env.DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL
	const usageUrl = env.DLINE_E2E_CLAUDE_CODE_USAGE_URL
		? normalizedUrl(loopbackHttpUrl("DLINE_E2E_CLAUDE_CODE_USAGE_URL", env.DLINE_E2E_CLAUDE_CODE_USAGE_URL))
		: CLAUDE_CODE_PRODUCTION_RUNTIME_CONFIG.usageUrl

	if (!oauthBase) {
		return {
			...CLAUDE_CODE_PRODUCTION_RUNTIME_CONFIG,
			usageUrl,
			...(env.DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS
				? { callbackPorts: callbackPorts(env.DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS) }
				: {}),
			...(env.DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS
				? {
						timeoutMs: positiveInteger(
							"DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS",
							env.DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS,
						),
					}
				: {}),
		}
	}

	const base = loopbackHttpUrl("DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL", oauthBase)
	return {
		authorizationEndpoint: appendPath(base, "authorize"),
		tokenEndpoint: appendPath(base, "token"),
		manualRedirectUri: appendPath(base, "code/callback"),
		usageUrl,
		...(env.DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS
			? { callbackPorts: callbackPorts(env.DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS) }
			: {}),
		...(env.DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS
			? {
					timeoutMs: positiveInteger(
						"DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS",
						env.DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS,
					),
				}
			: {}),
	}
}
