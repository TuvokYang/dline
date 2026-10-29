import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { WireResponse } from "../../contracts/classification"
import type { AtomicDeviceGrant, DeviceGrantProfile } from "../../contracts/deviceGrant"
import {
    EXCHANGE_OPERATION_TTL_MS,
    type ExchangeOperationRequest,
    type RecoverableExchangeTransport,
} from "../../contracts/exchangeOperation"
import { type DeviceGrantAttempt, type DeviceGrantPort, DeviceGrantRefusalError } from "../DeviceGrantPort"
import { RecoverableExchangeCoordinator } from "../RecoverableExchangeCoordinator"

const FIXTURE = JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", "contracts", "__tests__", "fixtures", "usage-schema4-reference.json"), "utf8"),
)
const PRINCIPAL = "p".repeat(43)
const TOKEN = "t".repeat(43)
const TOKEN_2 = "u".repeat(43)
const DEVICE_ID = "dev_0123456789abcdef0123456789abcdef"
const REQUEST_ID_1 = "11111111-1111-4111-8111-111111111111"
const REQUEST_ID_2 = "22222222-2222-4222-8222-222222222222"
const REQUEST_ID_3 = "44444444-4444-4444-8444-444444444444"
const DAY_MS = 24 * 60 * 60_000

interface GrantShape {
    readonly profile?: DeviceGrantProfile
    readonly token?: string
    readonly schemaVersion?: number
}

function grantResponse(requestId: string, expiresAt: number, shape: GrantShape = {}): WireResponse {
    const profile = shape.profile ?? "usage"
    return {
        status: 200,
        retryAfter: null,
        json: {
            ok: true,
            request_id: requestId,
            access_token: shape.token ?? TOKEN,
            device_id: DEVICE_ID,
            profile,
            scopes: [profile],
            expires_at: expiresAt,
            usage_contract: {
                ...FIXTURE.device_grant.response.usage_contract,
                ...(shape.schemaVersion === undefined ? {} : { schema_version: shape.schemaVersion }),
            },
        },
    }
}

function refusal(status: number, code: string): WireResponse {
    return { status, json: { ok: false, error: { code } }, retryAfter: null }
}

class MemoryGrantPort implements DeviceGrantPort {
    readonly grants = new Map<DeviceGrantProfile, AtomicDeviceGrant>()
    publishCount = 0
    failNextPublish = false

    async publish(grant: AtomicDeviceGrant, _deviceSecret: string): Promise<boolean> {
        if (this.failNextPublish) {
            this.failNextPublish = false
            throw new Error("process ended before publication")
        }
        this.publishCount += 1
        this.grants.set(grant.profile as DeviceGrantProfile, grant)
        return true
    }

    async readActive(profile: DeviceGrantProfile, now: number): Promise<AtomicDeviceGrant | null> {
        const grant = this.grants.get(profile)
        return grant && grant.expiresAt > now ? grant : null
    }
}

class ScriptedTransport implements RecoverableExchangeTransport {
    readonly requests: Array<ExchangeOperationRequest & Record<string, unknown>> = []
    readonly replies: Array<WireResponse | Error> = []

    async requestRecoverableDeviceOrIssueExchange(request: ExchangeOperationRequest & object): Promise<WireResponse> {
        this.requests.push(request as ExchangeOperationRequest & Record<string, unknown>)
        const reply = this.replies.shift()
        if (!reply) throw new Error("missing scripted response")
        if (reply instanceof Error) throw reply
        return reply
    }
}

function grantOf(attempt: DeviceGrantAttempt): AtomicDeviceGrant | undefined {
    return attempt.kind === "granted" ? attempt.grant : undefined
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => undefined,
        (failure: unknown) => failure,
    )
}

describe("RecoverableExchangeCoordinator", () => {
    let root: string
    let now: number
    let repository: ExchangeOperationRepository
    let port: MemoryGrantPort

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-recoverable-exchange-"))
        now = 1_790_000_000_000
        repository = new ExchangeOperationRepository(resolveOtelStorageLayout(path.join(root, "data")), { clock: () => now })
        port = new MemoryGrantPort()
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function coordinator(transport: RecoverableExchangeTransport, requestId = REQUEST_ID_1, clientVersion = "0.11.1") {
        return new RecoverableExchangeCoordinator({
            port,
            repository,
            transport,
            clientVersion,
            platform: "win32",
            clock: () => now,
            requestId: () => requestId,
        })
    }

    it("sends the fixture device.grant body, naming the profile it requests", async () => {
        const request = FIXTURE.device_grant.request
        const transport = new ScriptedTransport()
        transport.replies.push(new Error("unknown outcome"), new Error("unknown outcome"))
        const running = coordinator(transport, request.request_id, request.client_version)

        await running.ensureActiveGrant("usage", request.device_secret)
        await running.ensureActiveGrant("production", request.device_secret)

        expect(transport.requests[0]).toEqual(request)
        expect(transport.requests[1]).toEqual({ ...request, requested_profile: "production" })
    })

    it("replays the same request identity after an unknown transport outcome", async () => {
        const failed = new ScriptedTransport()
        failed.replies.push(new Error("connection reset"))
        await expect(coordinator(failed).ensureActiveGrant("usage", PRINCIPAL)).resolves.toEqual({ kind: "deferred" })

        const recovered = new ScriptedTransport()
        recovered.replies.push(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))
        const grant = grantOf(await coordinator(recovered, REQUEST_ID_2).ensureActiveGrant("usage", PRINCIPAL))

        expect(failed.requests[0]).toMatchObject({ request_id: REQUEST_ID_1 })
        expect(recovered.requests[0]).toMatchObject({ request_id: REQUEST_ID_1 })
        expect(grant?.accessToken).toBe(TOKEN)
        expect(port.publishCount).toBe(1)
    })

    it("does not seal retryable service errors and retries the same request over the network", async () => {
        const transport = new ScriptedTransport()
        transport.replies.push(
            { status: 503, json: { ok: false, error: { code: "unavailable" } }, retryAfter: "5" },
            grantResponse(REQUEST_ID_1, now + 30 * DAY_MS),
        )
        const running = coordinator(transport)

        await expect(running.ensureActiveGrant("usage", PRINCIPAL)).resolves.toEqual({ kind: "deferred", retryAfterMs: 5_000 })
        await expect(running.ensureActiveGrant("usage", PRINCIPAL)).resolves.toMatchObject({
            kind: "granted",
            grant: { accessToken: TOKEN },
        })

        expect(transport.requests.map((request) => request.request_id)).toEqual([REQUEST_ID_1, REQUEST_ID_1])
    })

    it("surfaces a revoked credential so the broker can clear every local token", async () => {
        const transport = new ScriptedTransport()
        transport.replies.push(refusal(403, "device_revoked"))

        const error = await rejection(coordinator(transport).ensureActiveGrant("usage", PRINCIPAL))

        expect(error).toBeInstanceOf(DeviceGrantRefusalError)
        expect((error as DeviceGrantRefusalError).refusal).toEqual({ kind: "reset_credential", code: "device_revoked" })
    })

    it("publishes a sealed response after a crash before publication without another request", async () => {
        const first = new ScriptedTransport()
        first.replies.push(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))
        port.failNextPublish = true
        await expect(coordinator(first).ensureActiveGrant("usage", PRINCIPAL)).rejects.toThrow("before publication")

        const transport: RecoverableExchangeTransport = {
            requestRecoverableDeviceOrIssueExchange: vi.fn(() => Promise.reject(new Error("must not send"))),
        }
        const grant = grantOf(await coordinator(transport, REQUEST_ID_2).ensureActiveGrant("usage", PRINCIPAL))

        expect(grant?.accessToken).toBe(TOKEN)
        expect(transport.requestRecoverableDeviceOrIssueExchange).not.toHaveBeenCalled()
        expect(port.publishCount).toBe(1)
    })

    it("starts a new operation when an upgrade changed the pending canonical body", async () => {
        const first = new ScriptedTransport()
        first.replies.push(new Error("unknown outcome"))
        await coordinator(first, REQUEST_ID_1, "0.11.1").ensureActiveGrant("usage", PRINCIPAL)

        const upgraded = new ScriptedTransport()
        upgraded.replies.push(grantResponse(REQUEST_ID_2, now + 30 * DAY_MS))
        const grant = grantOf(await coordinator(upgraded, REQUEST_ID_2, "0.11.2").ensureActiveGrant("usage", PRINCIPAL))

        expect(upgraded.requests).toEqual([expect.objectContaining({ request_id: REQUEST_ID_2, client_version: "0.11.2" })])
        expect(grant?.accessToken).toBe(TOKEN)
    })

    it("starts a new operation once the pending identity left its replay window", async () => {
        const first = new ScriptedTransport()
        first.replies.push(new Error("unknown outcome"))
        await coordinator(first).ensureActiveGrant("usage", PRINCIPAL)
        now += EXCHANGE_OPERATION_TTL_MS

        const later = new ScriptedTransport()
        later.replies.push(grantResponse(REQUEST_ID_2, now + 30 * DAY_MS))
        const grant = grantOf(await coordinator(later, REQUEST_ID_2).ensureActiveGrant("usage", PRINCIPAL))

        expect(later.requests.map((request) => request.request_id)).toEqual([REQUEST_ID_2])
        expect(grant?.accessToken).toBe(TOKEN)
    })

    it.each([
        [409, "request_id_conflict"],
        [410, "request_id_expired"],
    ])("drops the intent on %i %s and never resends the old bytes", async (status, code) => {
        const transport = new ScriptedTransport()
        transport.replies.push(refusal(status, code))
        await expect(coordinator(transport).ensureActiveGrant("usage", PRINCIPAL)).resolves.toEqual({ kind: "deferred" })

        const next = new ScriptedTransport()
        next.replies.push(grantResponse(REQUEST_ID_2, now + 30 * DAY_MS))
        await coordinator(next, REQUEST_ID_2).ensureActiveGrant("usage", PRINCIPAL)

        expect(next.requests.map((request) => request.request_id)).toEqual([REQUEST_ID_2])
    })

    it("keeps the usage and production operations apart", async () => {
        const usage = new ScriptedTransport()
        usage.replies.push(new Error("unknown outcome"))
        await coordinator(usage, REQUEST_ID_1).ensureActiveGrant("usage", PRINCIPAL)

        const production = new ScriptedTransport()
        production.replies.push(grantResponse(REQUEST_ID_2, now + 30 * DAY_MS, { profile: "production", token: TOKEN_2 }))
        const productionGrant = grantOf(await coordinator(production, REQUEST_ID_2).ensureActiveGrant("production", PRINCIPAL))

        const replay = new ScriptedTransport()
        replay.replies.push(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))
        const usageGrant = grantOf(await coordinator(replay, REQUEST_ID_3).ensureActiveGrant("usage", PRINCIPAL))

        expect(productionGrant).toMatchObject({ profile: "production", accessToken: TOKEN_2 })
        expect(replay.requests.map((request) => request.request_id)).toEqual([REQUEST_ID_1])
        expect(usageGrant).toMatchObject({ profile: "usage", accessToken: TOKEN })
    })

    it("requests a new grant only when the active token was rejected", async () => {
        const first = new ScriptedTransport()
        first.replies.push(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))
        await coordinator(first).ensureActiveGrant("usage", PRINCIPAL)
        const idle = new ScriptedTransport()
        const cached = grantOf(await coordinator(idle, REQUEST_ID_2).ensureActiveGrant("usage", PRINCIPAL))

        const rotated = new ScriptedTransport()
        rotated.replies.push(grantResponse(REQUEST_ID_2, now + 30 * DAY_MS, { token: TOKEN_2 }))
        const refreshed = grantOf(
            await coordinator(rotated, REQUEST_ID_2).ensureActiveGrant("usage", PRINCIPAL, { rejectedAccessToken: TOKEN }),
        )

        expect(cached?.accessToken).toBe(TOKEN)
        expect(idle.requests).toHaveLength(0)
        expect(rotated.requests.map((request) => request.request_id)).toEqual([REQUEST_ID_2])
        expect(refreshed?.accessToken).toBe(TOKEN_2)
    })

    it("refuses a grant of the retired schema 4 and ends its operation", async () => {
        const transport = new ScriptedTransport()
        transport.replies.push(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS, { schemaVersion: 4 }))

        const error = await rejection(coordinator(transport).ensureActiveGrant("usage", PRINCIPAL))
        const next = new ScriptedTransport()
        next.replies.push(grantResponse(REQUEST_ID_2, now + 30 * DAY_MS))
        await coordinator(next, REQUEST_ID_2).ensureActiveGrant("usage", PRINCIPAL)

        expect((error as DeviceGrantRefusalError).refusal).toEqual({ kind: "stop", scope: "profile", code: "malformed_grant" })
        expect(port.grants.size).toBe(1)
        expect(next.requests.map((request) => request.request_id)).toEqual([REQUEST_ID_2])
    })

    it("shares one transport attempt between concurrent callers", async () => {
        let release: ((response: WireResponse) => void) | undefined
        const transport: RecoverableExchangeTransport = {
            requestRecoverableDeviceOrIssueExchange: vi.fn(() => new Promise<WireResponse>((resolve) => (release = resolve))),
        }
        const running = coordinator(transport)
        const first = running.ensureActiveGrant("usage", PRINCIPAL)
        const second = running.ensureActiveGrant("usage", PRINCIPAL)
        while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
        release(grantResponse(REQUEST_ID_1, now + 30 * DAY_MS))

        const results = await Promise.all([first, second])
        expect(results.map((attempt) => grantOf(attempt)?.accessToken)).toEqual([TOKEN, TOKEN])
        expect(transport.requestRecoverableDeviceOrIssueExchange).toHaveBeenCalledTimes(1)
    })
})
