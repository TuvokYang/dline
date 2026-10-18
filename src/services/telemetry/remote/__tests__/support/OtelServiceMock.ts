import { createHash, randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * Loopback stand-in for the Dline telemetry service, written from the client's
 * view of the HTTP interface only: device exchange, bearer tokens on
 * `/v1/usage`, request-ID idempotency, and the per-device usage interval.
 * It deliberately keeps no knowledge of how the real service is built.
 */
export interface OtelServiceMockOptions {
    readonly usageIntervalMs?: number
    readonly tokenLifetimeMs?: number
}

export interface AcceptedUsage {
    readonly deviceId: string
    readonly requestId: string
    readonly body: unknown
}

interface IssuedToken {
    readonly deviceId: string
    readonly profile: string
    readonly expiresAt: number
}

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROFILES = new Set(["usage", "production", "development"])
const BODY_LIMIT_BYTES = 64 * 1024

export class OtelServiceMock {
    readonly accepted: AcceptedUsage[] = []
    private readonly tokens = new Map<string, IssuedToken>()
    private readonly requests = new Map<string, { deviceId: string; digest: string }>()
    private readonly lastAcceptedAt = new Map<string, number>()
    private readonly server = http.createServer((request, response) => {
        void this.route(request)
            .catch((): MockReply => failure(500, "internal"))
            .then((result) => send(response, result))
    })

    constructor(private readonly options: OtelServiceMockOptions = {}) {}

    /** Listen on an ephemeral loopback port and return the origin to pass to the client. */
    async start(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }

    private async route(request: http.IncomingMessage): Promise<MockReply> {
        const body = await readBody(request)
        if (request.method === "POST" && request.url === "/v1/auth/device/exchange") return this.exchange(body)
        if (request.method === "POST" && request.url === "/v1/usage") return this.usage(request, body)
        return failure(404, "not_found")
    }

    private exchange(body: Buffer | undefined): MockReply {
        const input = parseJson(body)
        const secret = input?.device_secret
        const profile = input?.requested_profile
        if (typeof secret !== "string" || !SECRET_PATTERN.test(secret) || typeof profile !== "string" || !PROFILES.has(profile)) {
            return failure(400, "invalid_request")
        }
        const deviceId = createHash("sha256").update(secret).digest("hex").slice(0, 24)
        const accessToken = randomBytes(32).toString("base64url")
        const expiresAt = Date.now() + (this.options.tokenLifetimeMs ?? 3_600_000)
        this.tokens.set(accessToken, { deviceId, profile, expiresAt })
        return { status: 200, body: { ok: true, access_token: accessToken, device_id: deviceId, profile, expires_at: expiresAt } }
    }

    private usage(request: http.IncomingMessage, body: Buffer | undefined): MockReply {
        const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1]
        const token = bearer ? this.tokens.get(bearer) : undefined
        if (!token || token.profile !== "usage" || token.expiresAt <= Date.now()) return failure(401, "token_invalid")
        const requestId = request.headers["x-dline-request-id"]
        if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return failure(400, "invalid_request_id")
        if (!body) return failure(413, "payload_too_large")

        // Idempotency is decided before anything else, so a replay is never held back by the interval.
        const digest = createHash("sha256").update(body).digest("hex")
        const previous = this.requests.get(requestId)
        if (previous) {
            return previous.deviceId === token.deviceId && previous.digest === digest
                ? { status: 200, body: { ok: true, disposition: "duplicate" } }
                : failure(409, "request_id_conflict")
        }
        const parsed = parseJson(body)
        if (!parsed || parsed.schema_version !== 1 || typeof parsed.counters !== "object") return failure(400, "invalid_usage")
        const interval = this.options.usageIntervalMs ?? 60_000
        const waitMs = Math.ceil((this.lastAcceptedAt.get(token.deviceId) ?? Number.NEGATIVE_INFINITY) + interval - Date.now())
        if (waitMs > 0) {
            return {
                status: 429,
                body: { ok: false, retry_after_ms: waitMs, error: { code: "usage_interval_not_elapsed" } },
                retryAfterSeconds: Math.ceil(waitMs / 1_000),
            }
        }
        this.lastAcceptedAt.set(token.deviceId, Date.now())
        this.requests.set(requestId, { deviceId: token.deviceId, digest })
        this.accepted.push({ deviceId: token.deviceId, requestId, body: parsed })
        return { status: 200, body: { ok: true, disposition: "accepted" } }
    }
}

interface MockReply {
    readonly status: number
    readonly body: unknown
    readonly retryAfterSeconds?: number
}

function failure(status: number, code: string): MockReply {
    return { status, body: { ok: false, error: { code } } }
}

/** Read the request body, or `undefined` once it exceeds the service's size limit. */
async function readBody(request: http.IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of request) {
        total += (chunk as Buffer).byteLength
        if (total > BODY_LIMIT_BYTES) return undefined
        chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
}

function parseJson(body: Buffer | undefined): Record<string, unknown> | undefined {
    try {
        const value: unknown = body ? JSON.parse(body.toString("utf8")) : undefined
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined
    } catch {
        return undefined
    }
}

function send(response: http.ServerResponse, reply: MockReply): void {
    response.statusCode = reply.status
    response.setHeader("content-type", "application/json")
    if (reply.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(reply.retryAfterSeconds))
    response.end(JSON.stringify(reply.body))
}
