import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { WireResponse } from "../../contracts/classification"
import { serializeUsageGrantContract, USAGE_GRANT_HARD_LIMITS } from "../../contracts/deviceGrant"
import type { ExchangeOperationRequest, RecoverableExchangeTransport } from "../../contracts/exchangeOperation"
import type { DeviceGrantRequest } from "../DeviceGrantPort"
import { REFRESH_CLAIM_TTL_MS } from "../DeviceTokenBroker"
import { createDeviceTokenBroker } from "../exchangeRuntime"

const DAY_MS = 24 * 60 * 60_000
const TOKEN_1 = "1".repeat(43)
const TOKEN_2 = "2".repeat(43)
const DEVICE_ID = "dev_0123456789abcdef0123456789abcdef"
const USAGE_CONTRACT = serializeUsageGrantContract({
    schemaVersion: 5,
    contractVersion: 1,
    ...USAGE_GRANT_HARD_LIMITS,
    defaultIntervalMs: 600_000,
    newBatchJitterMaxMs: 300_000,
})

type Reply = WireResponse | Error | ((request: DeviceGrantRequest) => WireResponse)

/** A complete grant answering whichever request it is sent for. */
function granted(accessToken: string, expiresAt: number): Reply {
    return (request) => ({
        status: 200,
        retryAfter: null,
        json: {
            ok: true,
            request_id: request.request_id,
            access_token: accessToken,
            device_id: DEVICE_ID,
            profile: request.requested_profile,
            scopes: [request.requested_profile],
            expires_at: expiresAt,
            usage_contract: USAGE_CONTRACT,
        },
    })
}

function refused(status: number, code: string, retryAfter: string | null = null): WireResponse {
    return { status, json: { ok: false, request_id: "r", retryable: false, error: { code, message: code } }, retryAfter }
}

/** A `/auth/device/grant` transport whose responses the test releases one by one. */
class ScriptedTransport implements RecoverableExchangeTransport {
    readonly requests: DeviceGrantRequest[] = []
    private readonly pending: Array<(reply: Reply) => void> = []
    private readonly queued: Reply[] = []

    requestRecoverableDeviceOrIssueExchange(request: ExchangeOperationRequest & object): Promise<WireResponse> {
        const grantRequest = request as DeviceGrantRequest
        this.requests.push(grantRequest)
        return new Promise((resolve, reject) => {
            const settle = (reply: Reply) => {
                if (reply instanceof Error) reject(reply)
                else resolve(typeof reply === "function" ? reply(grantRequest) : reply)
            }
            const next = this.queued.shift()
            if (next) settle(next)
            else this.pending.push(settle)
        })
    }

    reply(reply: Reply): void {
        const waiting = this.pending.shift()
        if (waiting) waiting(reply)
        else this.queued.push(reply)
    }
}

describe("DeviceTokenBroker over the device grant coordinator", () => {
    let root: string
    let layout: OtelStorageLayout
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-broker-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        now = 1_900_000_000_000
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    /** One VS Code window: its own repositories over the shared data root, as in production. */
    function window(transport: ScriptedTransport, ownerId: string) {
        const repository = new DeviceCredentialRepository(layout, { clock: () => now })
        const broker = createDeviceTokenBroker({
            layout,
            credentials: repository,
            transport,
            clientVersion: "0.11.0",
            platform: "win32",
            ownerId,
            clock: () => now,
        })
        return { repository, broker }
    }

    async function waitForRequests(transport: ScriptedTransport, count: number): Promise<void> {
        for (let attempt = 0; attempt < 200 && transport.requests.length < count; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(transport.requests).toHaveLength(count)
    }

    it("shares one grant request between concurrent callers in the same window", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))

        const [first, second] = await Promise.all([broker.acquire("usage"), broker.acquire("usage")])

        expect(transport.requests).toHaveLength(1)
        expect(transport.requests[0]).toMatchObject({
            operation: "device.grant",
            requested_profile: "usage",
            client_version: "0.11.0",
            platform: "win32",
        })
        expect(first).toEqual(second)
        expect(first).toMatchObject({ status: "ready", token: { accessToken: TOKEN_1, deviceId: DEVICE_ID } })
    })

    it("obtains the production token from the same grant endpoint, apart from the usage token", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        transport.reply(granted(TOKEN_2, now + 30 * DAY_MS))

        const production = await broker.acquire("production")
        const usage = await broker.acquire("usage")

        expect(transport.requests.map((request) => request.requested_profile)).toEqual(["production", "usage"])
        expect(production.status === "ready" && production.token.accessToken).toBe(TOKEN_1)
        expect(usage.status === "ready" && usage.token.accessToken).toBe(TOKEN_2)
    })

    it("lets exactly one window request while another defers, then hands the second window the shared grant", async () => {
        const transportA = new ScriptedTransport()
        const transportB = new ScriptedTransport()
        const a = window(transportA, "window-a")
        const b = window(transportB, "window-b")

        const requesting = a.broker.acquire("usage")
        await waitForRequests(transportA, 1)
        const whileRequesting = await b.broker.acquire("usage")
        transportA.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await requesting
        const afterwards = await b.broker.acquire("usage")

        expect(whileRequesting).toMatchObject({ status: "deferred", reason: "refresh_in_progress" })
        expect(afterwards.status === "ready" && afterwards.token.accessToken).toBe(TOKEN_1)
        expect(transportB.requests).toHaveLength(0)
    })

    it("uses a grant until it expires and requests a new one afterwards", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await broker.acquire("usage")

        now += 30 * DAY_MS - 1
        const beforeExpiry = await broker.acquire("usage")
        now += 1
        transport.reply(granted(TOKEN_2, now + 30 * DAY_MS))
        const afterExpiry = await broker.acquire("usage")

        expect(beforeExpiry.status === "ready" && beforeExpiry.token.accessToken).toBe(TOKEN_1)
        expect(afterExpiry.status === "ready" && afterExpiry.token.accessToken).toBe(TOKEN_2)
        expect(new Set(transport.requests.map((request) => request.request_id)).size).toBe(2)
    })

    it("requests a new grant for a token the service just rejected, even when it looks unexpired", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await broker.acquire("usage")

        transport.reply(granted(TOKEN_2, now + 30 * DAY_MS))
        const refreshed = await broker.acquire("usage", { rejectedAccessToken: TOKEN_1 })

        expect(refreshed.status === "ready" && refreshed.token.accessToken).toBe(TOKEN_2)
        expect(transport.requests).toHaveLength(2)
    })

    it("shares an enrollment refusal across windows and honours the server delay before trying again", async () => {
        const transportA = new ScriptedTransport()
        const transportB = new ScriptedTransport()
        const a = window(transportA, "window-a")
        const b = window(transportB, "window-b")
        transportA.reply(refused(429, "device_enrollment_rate_limited", "120"))

        const refusedOnce = await a.broker.acquire("usage")
        const otherWindow = await b.broker.acquire("usage")
        now += 120_000
        transportB.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        const recovered = await b.broker.acquire("usage")

        expect(refusedOnce).toEqual({ status: "deferred", retryAt: now, reason: "enrollment_backoff" })
        expect(otherWindow).toMatchObject({ status: "deferred", reason: "enrollment_backoff" })
        expect(recovered.status).toBe("ready")
        // The unknown outcome is replayed under its request identity, not minted again.
        expect(transportB.requests.map((request) => request.request_id)).toEqual([transportA.requests[0]?.request_id])
        const stored = await b.repository.read()
        expect(stored.status === "valid" && stored.document.enrollment).toBeUndefined()
    })

    it("backs off exponentially when the request fails without a server delay", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(new Error("socket hang up"))
        const first = await broker.acquire("usage")
        now = first.status === "deferred" ? first.retryAt : now
        transport.reply(refused(503, "service_unavailable"))
        const second = await broker.acquire("usage")

        expect(first.status === "deferred" && first.retryAt).toBe(1_900_000_000_000 + 60_000)
        expect(second.status === "deferred" && second.retryAt).toBe(now + 120_000)
    })

    it("takes over the refresh from a window that crashed while holding the claim", async () => {
        const crashed = window(new ScriptedTransport(), "window-crashed")
        await crashed.repository.ensure()
        await crashed.repository.mutate((current) => ({
            next: {
                ...current,
                refreshClaim: { ownerId: "window-crashed", profile: "usage", expiresAt: now + REFRESH_CLAIM_TTL_MS },
            },
            value: undefined,
        }))
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")

        const blocked = await broker.acquire("usage")
        now += REFRESH_CLAIM_TTL_MS + 1
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        const tookOver = await broker.acquire("usage")

        expect(blocked).toMatchObject({ status: "deferred", reason: "refresh_in_progress" })
        expect(tookOver.status === "ready" && tookOver.token.accessToken).toBe(TOKEN_1)
    })

    it("stops the machine and drops every token and grant when the service revoked the device", async () => {
        const transport = new ScriptedTransport()
        const { broker, repository } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await broker.acquire("usage")
        transport.reply(refused(403, "device_revoked"))

        const result = await broker.acquire("usage", { rejectedAccessToken: TOKEN_1 })

        expect(result).toEqual({ status: "stopped", scope: "all", code: "device_revoked" })
        const stored = await repository.read()
        expect(stored.status === "valid" && stored.document.tokens).toEqual({})
        expect(stored.status === "valid" && stored.document.grants).toEqual({})
        expect(stored.status === "valid" && stored.document.refreshClaim).toBeUndefined()
    })

    it("stops on an edge block page and releases the claim for the next decision", async () => {
        const transport = new ScriptedTransport()
        const { broker, repository } = window(transport, "window-a")
        transport.reply({ status: 403, json: undefined, retryAfter: null })

        const result = await broker.acquire("usage")

        expect(result).toEqual({ status: "stopped", scope: "all", code: "edge_blocked" })
        const stored = await repository.read()
        expect(stored.status === "valid" && stored.document.refreshClaim).toBeUndefined()
    })

    it("discards a grant that arrives after the identity was reset", async () => {
        const transport = new ScriptedTransport()
        const { broker, repository } = window(transport, "window-a")

        const requesting = broker.acquire("usage")
        await waitForRequests(transport, 1)
        await repository.resetIdentity()
        await repository.ensure()
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))

        expect(await requesting).toEqual({ status: "unavailable" })
        const stored = await repository.read()
        expect(stored.status === "valid" && stored.document.tokens).toEqual({})
        expect(stored.status === "valid" && stored.document.grants).toEqual({})
    })
})
