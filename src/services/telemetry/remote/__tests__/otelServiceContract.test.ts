import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import { DeviceTokenBroker } from "../auth/DeviceTokenBroker"
import { classifyDeliveryResponse, type WireResponse } from "../contracts/classification"
import { USAGE_MINUTE_MS, type UsageBodyWire } from "../contracts/usageBody"
import { DlineOtelHttpClient, type UsageDelivery, type UsageTransport } from "../transport/DlineOtelHttpClient"
import { UsageDeliveryWorker } from "../usage/UsageDeliveryWorker"
import { minuteStartOf } from "../usage/usageBatch"
import { projectUsageSettlement } from "../usage/usageTally"
import { OtelServiceMock } from "./support/OtelServiceMock"

/**
 * The HTTP contract between the usage client and the telemetry service, run
 * over real sockets. It always runs against a loopback mock of the service
 * interface; setting DLINE_OTEL_LIVE_ENDPOINT runs the same scenario against
 * that origin as well. Every run enrolls a fresh device from a temporary data root.
 */
const liveEndpoint = process.env.DLINE_OTEL_LIVE_ENDPOINT
const MINUTE = USAGE_MINUTE_MS
const SETTLE = 20_000
const VERSION = "0.11.1"

class RecordingTransport implements UsageTransport {
    readonly deliveries: UsageDelivery[] = []

    constructor(private readonly inner: UsageTransport) {}

    sendUsage(delivery: UsageDelivery, signal?: AbortSignal): Promise<WireResponse> {
        this.deliveries.push(delivery)
        return this.inner.sendUsage(delivery, signal)
    }
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("telemetry service contract", () => {
    it("holds against the loopback mock of the service interface", async () => {
        // Only this version is listed, so an acceptance proves the user agent names it.
        const service = new OtelServiceMock({ acceptedVersions: [VERSION] })
        const endpoint = await service.start()
        cleanups.push(() => service.stop())

        const sent = await runContractScenario(endpoint)

        // The service received the batch exactly once, byte-for-byte as the client built it.
        expect(service.accepted).toHaveLength(1)
        expect(service.accepted[0].body).toEqual(sent)
        // The body states the version the service matched on the user agent (§1.2).
        expect(service.accepted[0].userAgent).toBe(`Dline/${sent.client.version}`)
    })

    it.skipIf(!liveEndpoint)("holds against the live service", async () => {
        await runContractScenario(liveEndpoint as string)
    })
})

/**
 * Enroll, deliver one batch through the real worker and transport, then probe
 * idempotency, request ID conflicts, the server gate and token rejection.
 * Returns the batch the client sent.
 */
async function runContractScenario(endpoint: string): Promise<UsageBodyWire> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-contract-"))
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
    const layout = resolveOtelStorageLayout(root)
    const client = new DlineOtelHttpClient({ clientVersion: VERSION, endpoint })
    const transport = new RecordingTransport(client)
    const tokens = new DeviceTokenBroker({
        repository: new DeviceCredentialRepository(layout),
        transport: client,
        clientVersion: VERSION,
        platform: process.platform,
    })
    // The next minute boundary keeps the fake clock ahead of file times yet close to the service's clock.
    const start = minuteStartOf(Date.now()) + MINUTE
    let now = start + 1_000
    await new UsageObservationSpool(layout, "contract-observer").append({
        id: randomUUID(),
        receivedAt: now,
        policyEpoch: 1,
        tally: projectUsageSettlement({
            observationId: "contract",
            purpose: "task",
            outcome: "completed",
            inputTokens: 1_200,
            outputTokens: 300,
            cacheReadTokens: 800,
            cacheWriteTokens: 0,
            durationMs: 2_500,
        }),
    })
    const worker = new UsageDeliveryWorker({
        outbox: new UsageOutboxRepository(layout, { clock: () => now }),
        spool: new UsageObservationSpool(layout, "contract-sender"),
        tokens,
        transport,
        client: { version: VERSION, platform: process.platform, architecture: process.arch, is_dev: false },
        ownerId: "contract-sender",
        batchSettleMs: SETTLE,
        clock: () => now,
    })

    now = start + 2_000
    await worker.runCycle(1)
    now = start + MINUTE + SETTLE
    const delivered = await worker.runCycle(1)

    expect(delivered).toMatchObject({ kind: "delivered", disposition: "accepted" })
    expect(transport.deliveries).toHaveLength(1)
    const first = transport.deliveries[0]
    const sent = JSON.parse(new TextDecoder().decode(first.body)) as UsageBodyWire

    // The same request ID with the same bytes is acknowledged as a duplicate, not counted twice.
    const duplicate = classifyDeliveryResponse(await client.sendUsage(first))
    expect(duplicate).toMatchObject({ kind: "acknowledged", disposition: "duplicate" })
    expect(duplicate.kind === "acknowledged" ? duplicate.nextEligibleAt : undefined).toBeGreaterThan(0)

    // The same request ID with other bytes is a conflict the client must never retry.
    const altered = encode({ ...sent, sessions_started: sent.sessions_started + 1 })
    expect(classifyDeliveryResponse(await client.sendUsage({ ...first, body: altered }))).toEqual({
        kind: "discard",
        code: "request_id_conflict",
    })

    // A new batch before the gate the service named is refused before anything is stored, with a wait.
    const next = encode({ ...sent, window: { ...sent.window, started_at: start + MINUTE, ended_at: start + 2 * MINUTE } })
    const gated = classifyDeliveryResponse(await client.sendUsage({ ...first, requestId: randomUUID(), body: next }))
    expect(gated).toMatchObject({ kind: "wait", code: "rate_limited" })
    expect(gated.kind === "wait" ? gated.retryAfterMs : undefined).toBeGreaterThan(0)

    // A token the service never issued is answered with 401, which the client turns into one re-exchange.
    const forged = await client.sendUsage({ ...first, accessToken: `${first.accessToken.slice(0, -4)}AAAA` })
    expect(classifyDeliveryResponse(forged)).toEqual({ kind: "refresh_token" })
    return sent
}

function encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
}
