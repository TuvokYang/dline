/**
 * Why a provider request failed, in the vocabulary the telemetry service accepts.
 * A failure that fits none of them is `other`, never a new value.
 */
export const PROVIDER_FAILURE_CLASSES = [
    "rate_limited",
    "overloaded",
    "timeout",
    "auth",
    "network",
    "invalid_request",
    "other",
] as const
export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number]

/** How deep a chain of wrapped errors is followed before giving up; wrappers rarely nest more than twice. */
const MAX_CAUSE_DEPTH = 5

const STATUS_CLASSES: ReadonlyMap<number, ProviderFailureClass> = new Map([
    [429, "rate_limited"],
    [502, "overloaded"],
    [503, "overloaded"],
    [529, "overloaded"],
    [408, "timeout"],
    [504, "timeout"],
    [401, "auth"],
    [403, "auth"],
    [400, "invalid_request"],
    [404, "invalid_request"],
    [413, "invalid_request"],
    [422, "invalid_request"],
])

/** Provider error types, such as Anthropic's `error.type`, that name the class outright. */
const TYPE_CLASSES: ReadonlyMap<string, ProviderFailureClass> = new Map([
    ["rate_limit_error", "rate_limited"],
    ["overloaded_error", "overloaded"],
    ["authentication_error", "auth"],
    ["permission_error", "auth"],
    ["invalid_request_error", "invalid_request"],
])

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
])

const NETWORK_CODES: ReadonlySet<string> = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_SOCKET",
    "ERR_STREAM_PREMATURE_CLOSE",
])

/** Wording providers use when no status or code survives the transport. Order matters: the first match wins. */
const MESSAGE_CLASSES: readonly (readonly [RegExp, ProviderFailureClass])[] = [
    [/rate.?limit|too many requests/i, "rate_limited"],
    [/overloaded|over capacity|server is busy/i, "overloaded"],
    [/timed?.?out|timeout/i, "timeout"],
    [/fetch failed|socket hang up|network error|connection (reset|refused|closed)/i, "network"],
]

/** A provider error's stable code: a short token the diagnostics filter lets through. */
const STABLE_CODE = /^[A-Za-z0-9_.+-]{1,64}$/

/**
 * The failure class of a provider error.
 *
 * The error and every error it wraps are read for an HTTP status, a provider
 * error type and a transport code before falling back to the message, because
 * Dline wraps provider failures for display. Anything unrecognised is `other`.
 */
export function providerFailureClassOf(error: unknown): ProviderFailureClass {
    const chain = causeChainOf(error)
    for (const reader of [statusClassOf, typeClassOf, codeClassOf]) {
        for (const link of chain) {
            const failureClass = reader(link)
            if (failureClass) return failureClass
        }
    }
    for (const link of chain) {
        const message = typeof link.message === "string" ? link.message : ""
        const match = MESSAGE_CLASSES.find(([pattern]) => pattern.test(message))
        if (match) return match[1]
    }
    return "other"
}

/**
 * The diagnostic attributes of a failed provider request, under the keys the
 * telemetry console reads. Only the class, the exception type, a stable code and
 * the HTTP status are taken; the message never is.
 */
export function providerFailureAttributes(error: unknown): Record<string, string | number> {
    const chain = causeChainOf(error)
    const attributes: Record<string, string | number> = { "error.class": providerFailureClassOf(error) }
    const type = chain.map((link) => link.name).find((name): name is string => typeof name === "string" && STABLE_CODE.test(name))
    if (type) attributes["error.type"] = type
    const code = chain
        .flatMap((link) => [isErrorLike(link.error) ? link.error.type : undefined, link.type, link.code])
        .find((value): value is string => typeof value === "string" && STABLE_CODE.test(value))
    if (code) attributes["error.code"] = code
    const status = chain.map(statusOf).find((value) => value !== undefined)
    if (status !== undefined) attributes["http.status"] = status
    return attributes
}

type ErrorLike = Readonly<Record<string, unknown>>

function causeChainOf(error: unknown): ErrorLike[] {
    const chain: ErrorLike[] = []
    let current: unknown = error
    while (isErrorLike(current) && chain.length < MAX_CAUSE_DEPTH && !chain.includes(current)) {
        chain.push(current)
        current = current.cause
    }
    return chain
}

function statusOf(error: ErrorLike): number | undefined {
    const response = isErrorLike(error.response) ? error.response : undefined
    for (const candidate of [error.status, error.statusCode, response?.status]) {
        const status = typeof candidate === "string" ? Number.parseInt(candidate, 10) : candidate
        if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status
    }
    return undefined
}

function statusClassOf(error: ErrorLike): ProviderFailureClass | undefined {
    const status = statusOf(error)
    if (status === undefined) return undefined
    return STATUS_CLASSES.get(status) ?? (status >= 500 ? "other" : undefined)
}

function typeClassOf(error: ErrorLike): ProviderFailureClass | undefined {
    const body = isErrorLike(error.error) ? error.error : undefined
    for (const candidate of [error.type, body?.type]) {
        if (typeof candidate === "string" && TYPE_CLASSES.has(candidate)) return TYPE_CLASSES.get(candidate)
    }
    return undefined
}

function codeClassOf(error: ErrorLike): ProviderFailureClass | undefined {
    if (error.name === "TimeoutError") return "timeout"
    const code = typeof error.code === "string" ? error.code : undefined
    if (!code) return undefined
    if (TIMEOUT_CODES.has(code)) return "timeout"
    if (NETWORK_CODES.has(code)) return "network"
    return undefined
}

function isErrorLike(value: unknown): value is ErrorLike {
    return typeof value === "object" && value !== null
}
