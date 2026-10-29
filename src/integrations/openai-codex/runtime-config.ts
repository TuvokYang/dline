export const OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG = {
    apiBaseUrl: "https://chatgpt.com/backend-api/codex",
    responsesWebsocketUrl: "wss://chatgpt.com/backend-api/codex/responses",
    usageUrl: "https://chatgpt.com/backend-api/wham/usage",
    resetCreditsUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    consumeResetCreditUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
} as const

export type OpenAiCodexE2EOAuthMode = "automatic" | "manual"

export interface OpenAiCodexRuntimeConfig {
    apiBaseUrl: string
    responsesWebsocketUrl: string
    usageUrl: string
    resetCreditsUrl: string
    consumeResetCreditUrl: string
    e2eOAuth?: {
        authorizationEndpoint: string
        tokenEndpoint: string
        mode: OpenAiCodexE2EOAuthMode
        callbackPorts?: readonly number[]
        timeoutMs?: number
    }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

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

function replaceLastPathSegment(urlValue: string, segment: string): string {
    const url = new URL(urlValue)
    url.pathname = `${url.pathname.replace(/\/[^/]*\/?$/, "")}/${segment}`
    url.search = ""
    return normalizedUrl(url)
}

function oauthMode(value: string | undefined): OpenAiCodexE2EOAuthMode {
    if (value === undefined || value === "automatic") return "automatic"
    if (value === "manual") return value
    throw new Error("DLINE_E2E_OPENAI_CODEX_OAUTH_MODE must be automatic or manual.")
}

function positiveInteger(name: string, value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
    return parsed
}

function callbackPorts(value: string | undefined): readonly number[] | undefined {
    if (value === undefined) return undefined
    const ports = value.split(",").map((port) => {
        const trimmed = port.trim()
        if (!/^\d+$/.test(trimmed)) throw new Error("DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS must contain TCP ports.")
        const parsed = Number(trimmed)
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
            throw new Error("DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS must contain TCP ports.")
        }
        return parsed
    })
    if (ports.length === 0) throw new Error("DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS must contain TCP ports.")
    return ports
}

export function resolveOpenAiCodexRuntimeConfig(env: NodeJS.ProcessEnv = process.env): OpenAiCodexRuntimeConfig {
    if (env.E2E_TEST !== "true") return OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG

    const apiBaseUrl = env.DLINE_E2E_OPENAI_CODEX_API_BASE_URL
        ? normalizedUrl(loopbackHttpUrl("DLINE_E2E_OPENAI_CODEX_API_BASE_URL", env.DLINE_E2E_OPENAI_CODEX_API_BASE_URL))
        : OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG.apiBaseUrl
    const usageUrl = env.DLINE_E2E_OPENAI_CODEX_USAGE_URL
        ? normalizedUrl(loopbackHttpUrl("DLINE_E2E_OPENAI_CODEX_USAGE_URL", env.DLINE_E2E_OPENAI_CODEX_USAGE_URL))
        : OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG.usageUrl
    const resetCreditsUrl = env.DLINE_E2E_OPENAI_CODEX_RESET_CREDITS_URL
        ? normalizedUrl(loopbackHttpUrl("DLINE_E2E_OPENAI_CODEX_RESET_CREDITS_URL", env.DLINE_E2E_OPENAI_CODEX_RESET_CREDITS_URL))
        : env.DLINE_E2E_OPENAI_CODEX_USAGE_URL
          ? replaceLastPathSegment(usageUrl, "rate-limit-reset-credits")
          : OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG.resetCreditsUrl
    const consumeResetCreditUrl = env.DLINE_E2E_OPENAI_CODEX_CONSUME_RESET_CREDIT_URL
        ? normalizedUrl(
              loopbackHttpUrl(
                  "DLINE_E2E_OPENAI_CODEX_CONSUME_RESET_CREDIT_URL",
                  env.DLINE_E2E_OPENAI_CODEX_CONSUME_RESET_CREDIT_URL,
              ),
          )
        : `${resetCreditsUrl}/consume`
    const oauthBase = env.DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL

    return {
        apiBaseUrl,
        responsesWebsocketUrl: OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG.responsesWebsocketUrl,
        usageUrl,
        resetCreditsUrl,
        consumeResetCreditUrl,
        ...(oauthBase
            ? {
                  e2eOAuth: {
                      authorizationEndpoint: appendPath(
                          loopbackHttpUrl("DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL", oauthBase),
                          `authorize/${oauthMode(env.DLINE_E2E_OPENAI_CODEX_OAUTH_MODE)}`,
                      ),
                      tokenEndpoint: appendPath(loopbackHttpUrl("DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL", oauthBase), "token"),
                      mode: oauthMode(env.DLINE_E2E_OPENAI_CODEX_OAUTH_MODE),
                      callbackPorts: callbackPorts(env.DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS),
                      timeoutMs: positiveInteger(
                          "DLINE_E2E_OPENAI_CODEX_OAUTH_TIMEOUT_MS",
                          env.DLINE_E2E_OPENAI_CODEX_OAUTH_TIMEOUT_MS,
                      ),
                  },
              }
            : {}),
    }
}
