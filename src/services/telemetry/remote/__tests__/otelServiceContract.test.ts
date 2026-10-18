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
import { classifyUsageResponse, type WireResponse } from "../contracts/classification"
import { USAGE_WINDOW_MS, type UsageAggregateWire } from "../contracts/wire"
import { DlineOtelHttpClient, type UsageDelivery, type UsageTransport } from "../transport/DlineOtelHttpClient"
import { UsageDeliveryWorker } from "../usage/UsageDeliveryWorker"
import { projectUsageSettlement } from "../usage/usageCatalog"
import { windowStartOf } from "../usage/usageWindow"
import { OtelServiceMock } from "./support/OtelServiceMock"

/**
 * The HTTP contract between the usage client and the telemetry service, run
 * over real sockets. It always runs against a loopback mock of the service
 * interface; setting DLINE_OTEL_LIVE_ENDPOINT runs the same scenario against
 * that origin as well. Every run enrolls a fresh device from a temporary data root.
 */
const liveEndpoint = process.env.DLINE_OTEL_LIVE_ENDPOINT
const MINUTE = USAGE_WINDOW_MS
const SETTLE = 20_000

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
        const service = new OtelServiceMock()
        const endpoint = await service.start()
        cleanups.push(() => service.stop())

        const sent = await runContractScenario(endpoint)

        // The service received the batch exactly once, byte-for-byte as the client built it.
        expect(service.accepted).toHaveLength(1)
        expect(service.accepted[0].body).toEqual(sent)
    })

    it.skipIf(!liveEndpoint)("holds against the live service", async () => {
        await runContractScenario(liveEndpoint as string)
    })
})

/**
 * Enroll, deliver one batch through the real worker and transport, then probe
 * idempotency, request ID conflicts, the usage interval and token rejection.
 * Returns the batch the client sent.
 */
async function runContractScenario(endpoint: string): Promise<UsageAggregateWire> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-contract-"))
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
    const layout = resolveOtelStorageLayout(root)
    const client = new DlineOtelHttpClient({ endpoint })
    const transport = new RecordingTransport(client)
    const tokens = new DeviceTokenBroker({
        repository: new DeviceCredentialRepository(layout),
        transport: client,
        clientVersion: "0.11.0",
        platform: process.platform,
    })
    // The next minute boundary keeps the fake clock ahead of file times yet well inside the service's clock skew.
    const start = windowStartOf(Date.now()) + MINUTE
    let now = start + 1_000
    await new UsageObservationSpool(layout, "contract-observer").append({
        id: randomUUID(),
        receivedAt: now,
        policyEpoch: 1,
        ...projectUsageSettlement({
            observationId: "contract",
            purpose: "task",
            outcome: "completed",
            inputTokens: 1_200,
            outputTokens: 300,
            cacheReadTokens: 800,
            cacheWriteTokens: 0,
            costMicroUsd: 4_500,
            durationMs: 2_500,
        }),
    })
    const worker = new UsageDeliveryWorker({
        outbox: new UsageOutboxRepository(layout, { clock: () => now }),
        spool: new UsageObservationSpool(layout, "contract-sender"),
        tokens,
        transport,
        attributes: { client_version: "0.11.0", platform: process.platform, architecture: process.arch, is_dev: false },
        ownerId: "contract-sender",
        batchSettleMs: SETTLE,
        clock: () => now,
    })

    now = start + 2_000
    await worker.runCycle(1)
    now = start + MINUTE + SETTLE
    const delivered = await worker.runCycle(1)

    expect(delivered).toMatchObject({ kind: "delivered", duplicate: false })
    expect(transport.deliveries).toHaveLength(1)
    const first = transport.deliveries[0]
    const sent = JSON.parse(new TextDecoder().decode(first.body)) as UsageAggregateWire

    // The same request ID with the same bytes is acknowledged as a duplicate, not counted twice.
    expect(classifyUsageResponse(await client.sendUsage(first))).toEqual({ kind: "acknowledged", duplicate: true })

    // The same request ID with other bytes is a conflict the client must never retry.
    const altered = encode({ ...sent, counters: { ...sent.counters, "dline.usage.requests.task.completed": 2 } })
    expect(classifyUsageResponse(await client.sendUsage({ ...first, body: altered }))).toEqual({
        kind: "discard",
        code: "request_id_conflict",
    })

    // A new batch within 60 seconds is refused before anything is stored, with a retry delay.
    const next = encode({ ...sent, window_started_at: start + MINUTE, window_ended_at: start + 2 * MINUTE })
    const gated = classifyUsageResponse(await client.sendUsage({ ...first, requestId: randomUUID(), body: next }))
    expect(gated).toMatchObject({ kind: "defer", code: "usage_interval_not_elapsed" })
    expect(gated.kind === "defer" ? gated.retryAfterMs : undefined).toBeGreaterThan(0)

    // A token the service never issued is answered with 401, which the client turns into one re-exchange.
    const forged = await client.sendUsage({ ...first, accessToken: `${first.accessToken.slice(0, -4)}AAAA` })
    expect(classifyUsageResponse(forged)).toEqual({ kind: "refresh_token" })
    return sent
}

function encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
}
