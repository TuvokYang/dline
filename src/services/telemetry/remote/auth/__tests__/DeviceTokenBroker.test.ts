import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { WireResponse } from "../../contracts/classification"
import type { AtomicDeviceGrant } from "../../contracts/deviceGrant"
import type { DeviceExchangeRequest } from "../../contracts/wire"
import {
    type BootstrapDeviceGrantRequest,
    type DeviceGrantClient,
    type DeviceGrantPort,
    DeviceGrantRefusalError,
    type DeviceGrantTransport,
} from "../DeviceGrantPort"
import { DeviceGrantPortRegistry } from "../DeviceGrantPortRegistry"
import { type DeviceExchangeTransport, DeviceTokenBroker, REFRESH_CLAIM_TTL_MS } from "../DeviceTokenBroker"
import { USAGE_GRANT_BOOTSTRAP_BACKOFF_BASE_MS, UsageGrantBootstrap } from "../UsageGrantBootstrap"

const DAY_MS = 24 * 60 * 60_000
const TOKEN_1 = "1".repeat(43)
const TOKEN_2 = "2".repeat(43)
const DEVICE_SECRET = "s".repeat(43)
const GRANT_REQUEST_ID = "33333333-3333-4333-8333-333333333333"

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

    it("never falls back to the legacy issuer after a recoverable grant owner takes authority", async () => {
        const transport = new ScriptedTransport()
        const repository = new DeviceCredentialRepository(layout, { clock: () => now })
        const recoverable: DeviceGrantClient = {
            allowsLegacyFallback: false,
            ensureActiveGrant: async () => null,
        }
        const broker = new DeviceTokenBroker({
            repository,
            transport,
            clientVersion: "0.11.0",
            platform: "win32",
            clock: () => now,
            ownerId: "window-a",
            grantClient: recoverable,
        })

        const result = await broker.acquire("usage")

        expect(result).toMatchObject({ status: "deferred", reason: "enrollment_backoff" })
        expect(transport.requests).toHaveLength(0)
    })

    it("clears recoverable grant state and stops the machine when the service revoked the device", async () => {
        const transport = new ScriptedTransport()
        const repository = new DeviceCredentialRepository(layout, { clock: () => now })
        await repository.ensure()
        await repository.publishDeviceGrantAtomically({ ...SCHEMA4_GRANT, expiresAt: now + DAY_MS })
        const recoverable: DeviceGrantClient = {
            allowsLegacyFallback: false,
            readActiveGrant: async () => null,
            ensureActiveGrant: async () => {
                throw new DeviceGrantRefusalError({ kind: "reset_credential", code: "device_revoked" })
            },
        }
        const broker = new DeviceTokenBroker({
            repository,
            transport,
            clientVersion: "0.11.0",
            platform: "win32",
            clock: () => now,
            ownerId: "window-a",
            grantClient: recoverable,
        })

        const result = await broker.acquire("usage", { rejectedAccessToken: TOKEN_1 })
        const stored = await repository.read()

        expect(result).toEqual({ status: "stopped", scope: "all", code: "device_revoked" })
        expect(stored.status === "valid" && stored.document.tokens).toEqual({})
        expect(stored.status === "valid" && stored.document.grants).toEqual({})
        expect(transport.requests).toHaveLength(0)
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

    it("prefers a complete atomic usage grant without running the legacy exchange", async () => {
        const repository = new DeviceCredentialRepository(layout, { clock: () => now })
        const transport = new ScriptedTransport()
        const observedSecrets: string[] = []
        const grantClient: DeviceGrantClient = {
            ensureActiveGrant: async (deviceSecret) => {
                observedSecrets.push(deviceSecret)
                return SCHEMA4_GRANT
            },
        }
        const broker = new DeviceTokenBroker({
            repository,
            transport,
            clientVersion: "0.12.0",
            platform: "win32",
            clock: () => now,
            ownerId: "window-a",
            grantClient,
        })

        const acquisition = await broker.acquire("usage")
        const stored = await repository.read()

        expect(acquisition).toEqual({
            status: "ready",
            token: {
                accessToken: SCHEMA4_GRANT.accessToken,
                deviceId: SCHEMA4_GRANT.deviceId,
                expiresAt: SCHEMA4_GRANT.expiresAt,
                obtainedAt: now,
            },
        })
        expect(observedSecrets).toEqual([stored.status === "valid" ? stored.document.deviceSecret : undefined])
        expect(transport.requests).toEqual([])
    })

    it("lets only the machine-wide claim holder probe bootstrap while another window defers", async () => {
        const repositoryA = new DeviceCredentialRepository(layout, { clock: () => now })
        const repositoryB = new DeviceCredentialRepository(layout, { clock: () => now })
        let releaseGrant: (grant: AtomicDeviceGrant) => void = () => undefined
        let announceStarted: () => void = () => undefined
        const started = new Promise<void>((resolve) => {
            announceStarted = resolve
        })
        const pendingGrant = new Promise<AtomicDeviceGrant>((resolve) => {
            releaseGrant = resolve
        })
        let grantRequests = 0
        const grantClient: DeviceGrantClient = {
            ensureActiveGrant: async () => {
                grantRequests += 1
                announceStarted()
                return pendingGrant
            },
        }
        const createBroker = (repository: DeviceCredentialRepository, ownerId: string) =>
            new DeviceTokenBroker({
                repository,
                transport: new ScriptedTransport(),
                clientVersion: "0.12.0",
                platform: "win32",
                clock: () => now,
                ownerId,
                grantClient,
            })
        const first = createBroker(repositoryA, "window-a")
        const second = createBroker(repositoryB, "window-b")

        const acquiring = first.acquire("usage")
        await started
        const deferred = await second.acquire("usage")
        releaseGrant(SCHEMA4_GRANT)
        const acquired = await acquiring

        expect(grantRequests).toBe(1)
        expect(deferred).toMatchObject({ status: "deferred", reason: "refresh_in_progress" })
        expect(acquired.status === "ready" && acquired.token.accessToken).toBe(TOKEN_1)
        const stored = await repositoryA.read()
        expect(stored.status === "valid" && stored.document.refreshClaim).toBeUndefined()
    })

    it("falls back to the legacy exchange when capability bootstrap has no active grant", async () => {
        const repository = new DeviceCredentialRepository(layout, { clock: () => now })
        const transport = new ScriptedTransport()
        transport.reply(granted(TOKEN_2, now + 30 * DAY_MS))
        let grantRequests = 0
        const grantClient: DeviceGrantClient = {
            ensureActiveGrant: async () => {
                grantRequests += 1
                return null
            },
        }
        const broker = new DeviceTokenBroker({
            repository,
            transport,
            clientVersion: "0.12.0",
            platform: "win32",
            clock: () => now,
            ownerId: "window-a",
            grantClient,
        })

        const acquisition = await broker.acquire("usage")

        expect(grantRequests).toBe(1)
        expect(acquisition.status === "ready" && acquisition.token.accessToken).toBe(TOKEN_2)
        expect(transport.requests).toHaveLength(1)
    })
})

const SCHEMA4_GRANT: AtomicDeviceGrant = {
    accessToken: TOKEN_1,
    deviceId: "device-1",
    profile: "usage",
    scopes: ["usage"],
    expiresAt: 2_000_000_000_000,
    usageContract: {
        schemaVersion: 4,
        contractVersion: 4,
        maxBodyBytes: 65_536,
        maxBuckets: 8,
        maxFacts: 32,
        maxToolRows: 384,
        maxWriteRows: 486,
        eventWindowMs: 600_000,
        defaultIntervalMs: 600_000,
        newBatchJitterMaxMs: 300_000,
    },
}

class MemoryGrantPort implements DeviceGrantPort {
    readonly publications: AtomicDeviceGrant[] = []
    active: AtomicDeviceGrant | null = null

    async publish(grant: AtomicDeviceGrant): Promise<void> {
        this.publications.push(grant)
        this.active = grant
    }

    async readActive(now: number): Promise<AtomicDeviceGrant | null> {
        return this.active && this.active.expiresAt > now ? this.active : null
    }
}

class BootstrapGrantTransport implements DeviceGrantTransport {
    readonly requests: BootstrapDeviceGrantRequest[] = []

    constructor(readonly response: WireResponse) {}

    async requestBootstrapDeviceGrant(request: BootstrapDeviceGrantRequest): Promise<WireResponse> {
        this.requests.push(request)
        return this.response
    }
}

function schema4Response(overrides: Record<string, unknown> = {}): WireResponse {
    return {
        status: 200,
        retryAfter: null,
        json: {
            ok: true,
            request_id: GRANT_REQUEST_ID,
            access_token: SCHEMA4_GRANT.accessToken,
            device_id: SCHEMA4_GRANT.deviceId,
            profile: SCHEMA4_GRANT.profile,
            scopes: SCHEMA4_GRANT.scopes,
            expires_at: SCHEMA4_GRANT.expiresAt,
            usage_contract: {
                schema_version: 4,
                contract_version: 4,
                max_body_bytes: 65_536,
                max_buckets: 8,
                max_facts: 32,
                max_tool_rows: 384,
                max_write_rows: 486,
                event_window_ms: 600_000,
                default_interval_ms: 600_000,
                new_batch_jitter_max_ms: 300_000,
            },
            ...overrides,
        },
    }
}

describe("UsageGrantBootstrap", () => {
    it("requests schema 4 with one operation identity and publishes only the complete grant", async () => {
        const port = new MemoryGrantPort()
        const transport = new BootstrapGrantTransport(schema4Response())
        const bootstrap = new UsageGrantBootstrap({
            port,
            transport,
            clientVersion: "0.12.0",
            platform: "win32",
            clock: () => 1_900_000_000_000,
            requestId: () => GRANT_REQUEST_ID,
        })

        const grant = await bootstrap.ensureActiveGrant(DEVICE_SECRET)

        expect(grant).toEqual(SCHEMA4_GRANT)
        expect(port.publications).toEqual([SCHEMA4_GRANT])
        expect(transport.requests).toEqual([
            {
                operation: "device.grant",
                request_id: GRANT_REQUEST_ID,
                device_secret: DEVICE_SECRET,
                requested_profile: "usage",
                client_version: "0.12.0",
                platform: "win32",
                supported_usage_schema_versions: [4],
            },
        ])
    })

    it("backs off failed bootstrap requests, recovers at the boundary and resets after success", async () => {
        let clock = 1_900_000_000_000
        const port = new MemoryGrantPort()
        const requests: BootstrapDeviceGrantRequest[] = []
        const responses: WireResponse[] = [
            { status: 500, json: undefined, retryAfter: null },
            schema4Response(),
            { status: 500, json: undefined, retryAfter: null },
            schema4Response(),
        ]
        const transport: DeviceGrantTransport = {
            requestBootstrapDeviceGrant: async (request) => {
                requests.push(request)
                const response = responses.shift()
                if (!response) throw new Error("Unexpected bootstrap request")
                return response
            },
        }
        const bootstrap = new UsageGrantBootstrap({
            port,
            transport,
            clientVersion: "0.12.0",
            platform: "win32",
            clock: () => clock,
            requestId: () => GRANT_REQUEST_ID,
        })

        expect(await bootstrap.ensureActiveGrant(DEVICE_SECRET)).toBeNull()
        clock += USAGE_GRANT_BOOTSTRAP_BACKOFF_BASE_MS - 1
        expect(await bootstrap.ensureActiveGrant(DEVICE_SECRET)).toBeNull()
        expect(requests).toHaveLength(1)

        clock += 1
        expect(await bootstrap.ensureActiveGrant(DEVICE_SECRET)).toEqual(SCHEMA4_GRANT)
        expect(requests).toHaveLength(2)

        port.active = null
        expect(await bootstrap.ensureActiveGrant(DEVICE_SECRET)).toBeNull()
        clock += USAGE_GRANT_BOOTSTRAP_BACKOFF_BASE_MS - 1
        expect(await bootstrap.ensureActiveGrant(DEVICE_SECRET)).toBeNull()
        expect(requests).toHaveLength(3)

        clock += 1
        expect(await bootstrap.ensureActiveGrant(DEVICE_SECRET)).toEqual(SCHEMA4_GRANT)
        expect(requests).toHaveLength(4)
    })

    it("reuses an active grant and refuses mismatched or partial grant responses without publishing", async () => {
        const activePort = new MemoryGrantPort()
        activePort.active = SCHEMA4_GRANT
        const unusedTransport = new BootstrapGrantTransport({ status: 500, json: undefined, retryAfter: null })
        const cached = new UsageGrantBootstrap({
            port: activePort,
            transport: unusedTransport,
            clientVersion: "0.12.0",
            platform: "win32",
            clock: () => 1_900_000_000_000,
            requestId: () => GRANT_REQUEST_ID,
        })
        expect(await cached.ensureActiveGrant(DEVICE_SECRET)).toEqual(SCHEMA4_GRANT)
        expect(unusedTransport.requests).toEqual([])

        for (const response of [
            schema4Response({ request_id: "another-request" }),
            schema4Response({ usage_contract: undefined }),
        ]) {
            const port = new MemoryGrantPort()
            const bootstrap = new UsageGrantBootstrap({
                port,
                transport: new BootstrapGrantTransport(response),
                clientVersion: "0.12.0",
                platform: "win32",
                clock: () => 1_900_000_000_000,
                requestId: () => GRANT_REQUEST_ID,
            })
            expect(await bootstrap.ensureActiveGrant(DEVICE_SECRET)).toBeNull()
            expect(port.publications).toEqual([])
        }
    })

    it("hands off from bootstrap to a recoverable client without replacing the credential port", async () => {
        const port = new MemoryGrantPort()
        const bootstrap: DeviceGrantClient = { ensureActiveGrant: async () => SCHEMA4_GRANT }
        const recoverableGrant = { ...SCHEMA4_GRANT, accessToken: TOKEN_2 }
        const recoverable: DeviceGrantClient = { ensureActiveGrant: async () => recoverableGrant }
        const stale: DeviceGrantClient = { ensureActiveGrant: async () => null }
        const registry = new DeviceGrantPortRegistry(port, bootstrap)

        expect(registry.port).toBe(port)
        expect(await registry.ensureActiveGrant(DEVICE_SECRET)).toEqual(SCHEMA4_GRANT)
        expect(registry.adopt(bootstrap, recoverable)).toBe(true)
        expect(registry.adopt(bootstrap, stale)).toBe(false)
        expect(registry.port).toBe(port)
        expect(await registry.ensureActiveGrant(DEVICE_SECRET)).toEqual(recoverableGrant)
    })
})
