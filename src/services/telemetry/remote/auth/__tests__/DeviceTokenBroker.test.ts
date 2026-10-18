import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { WireResponse } from "../../contracts/classification"
import type { DeviceExchangeRequest } from "../../contracts/wire"
import { type DeviceExchangeTransport, DeviceTokenBroker, REFRESH_CLAIM_TTL_MS } from "../DeviceTokenBroker"

const DAY_MS = 24 * 60 * 60_000
const TOKEN_1 = "1".repeat(43)
const TOKEN_2 = "2".repeat(43)

function granted(accessToken: string, expiresAt: number): WireResponse {
    return {
        status: 200,
        json: { ok: true, access_token: accessToken, device_id: "device-1", profile: "usage", expires_at: expiresAt },
        retryAfter: null,
    }
}

function refused(status: number, code: string, retryAfter: string | null = null): WireResponse {
    return { status, json: { ok: false, request_id: "r", retryable: false, error: { code, message: code } }, retryAfter }
}

/** A transport whose responses the test releases one by one, recording every request it was asked to send. */
class ScriptedTransport implements DeviceExchangeTransport {
    readonly requests: DeviceExchangeRequest[] = []
    private readonly pending: Array<(response: WireResponse | Error) => void> = []
    private readonly queued: Array<WireResponse | Error> = []

    exchange(request: DeviceExchangeRequest): Promise<WireResponse> {
        this.requests.push(request)
        return new Promise((resolve, reject) => {
            const settle = (response: WireResponse | Error) => (response instanceof Error ? reject(response) : resolve(response))
            const next = this.queued.shift()
            if (next) settle(next)
            else this.pending.push(settle)
        })
    }

    reply(response: WireResponse | Error): void {
        const waiting = this.pending.shift()
        if (waiting) waiting(response)
        else this.queued.push(response)
    }
}

describe("DeviceTokenBroker", () => {
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

    function window(transport: DeviceExchangeTransport, ownerId: string) {
        const repository = new DeviceCredentialRepository(layout, { clock: () => now })
        const broker = new DeviceTokenBroker({
            repository,
            transport,
            clientVersion: "0.11.0",
            platform: "win32",
            clock: () => now,
            ownerId,
        })
        return { repository, broker }
    }

    async function waitForRequests(transport: ScriptedTransport, count: number): Promise<void> {
        for (let attempt = 0; attempt < 200 && transport.requests.length < count; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(transport.requests).toHaveLength(count)
    }

    it("shares one exchange between concurrent callers in the same window", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))

        const [first, second] = await Promise.all([broker.acquire("usage"), broker.acquire("usage")])

        expect(transport.requests).toHaveLength(1)
        expect(transport.requests[0]).toMatchObject({ requested_profile: "usage", client_version: "0.11.0", platform: "win32" })
        expect(first).toEqual(second)
        expect(first.status === "ready" && first.token.accessToken).toBe(TOKEN_1)
    })

    it("lets exactly one window exchange while another defers, then hands the second window the shared token", async () => {
        const transportA = new ScriptedTransport()
        const transportB = new ScriptedTransport()
        const a = window(transportA, "window-a")
        const b = window(transportB, "window-b")

        const exchanging = a.broker.acquire("usage")
        await waitForRequests(transportA, 1)
        const whileExchanging = await b.broker.acquire("usage")
        transportA.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await exchanging
        const afterwards = await b.broker.acquire("usage")

        expect(whileExchanging).toMatchObject({ status: "deferred", reason: "refresh_in_progress" })
        expect(afterwards.status === "ready" && afterwards.token.accessToken).toBe(TOKEN_1)
        expect(transportB.requests).toHaveLength(0)
    })

    it("reuses the stored token until its refresh margin and exchanges again after it", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await broker.acquire("usage")

        now += 26 * DAY_MS
        const beforeMargin = await broker.acquire("usage")
        now += 2 * DAY_MS
        transport.reply(granted(TOKEN_2, now + 30 * DAY_MS))
        const afterMargin = await broker.acquire("usage")

        expect(beforeMargin.status === "ready" && beforeMargin.token.accessToken).toBe(TOKEN_1)
        expect(afterMargin.status === "ready" && afterMargin.token.accessToken).toBe(TOKEN_2)
        expect(transport.requests).toHaveLength(2)
    })

    it("does not hand back a token the service just rejected, even when it looks unexpired", async () => {
        const transport = new ScriptedTransport()
        const { broker } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await broker.acquire("usage")

        transport.reply(granted(TOKEN_2, now + 30 * DAY_MS))
        const refreshed = await broker.acquire("usage", { rejectedAccessToken: TOKEN_1 })

        expect(refreshed.status === "ready" && refreshed.token.accessToken).toBe(TOKEN_2)
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
        expect(transportB.requests).toHaveLength(1)
        const stored = await b.repository.read()
        expect(stored.status === "valid" && stored.document.enrollment).toBeUndefined()
    })

    it("backs off exponentially when the exchange fails without a server delay", async () => {
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

    it("stops the machine and drops every token when the service revoked the device", async () => {
        const transport = new ScriptedTransport()
        const { broker, repository } = window(transport, "window-a")
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))
        await broker.acquire("usage")
        transport.reply(refused(403, "device_revoked"))

        const result = await broker.acquire("usage", { rejectedAccessToken: TOKEN_1 })

        expect(result).toEqual({ status: "stopped", scope: "all", code: "device_revoked" })
        const stored = await repository.read()
        expect(stored.status === "valid" && stored.document.tokens).toEqual({})
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

        const exchanging = broker.acquire("usage")
        await waitForRequests(transport, 1)
        await repository.resetIdentity()
        await repository.ensure()
        transport.reply(granted(TOKEN_1, now + 30 * DAY_MS))

        expect(await exchanging).toEqual({ status: "unavailable" })
        const stored = await repository.read()
        expect(stored.status === "valid" && stored.document.tokens).toEqual({})
    })
})
