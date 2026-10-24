import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import { deviceGrantPortFromRepository } from "../auth/DeviceGrantPort"
import { DeviceGrantPortRegistry } from "../auth/DeviceGrantPortRegistry"
import { DeviceTokenBroker } from "../auth/DeviceTokenBroker"
import { installRecoverableExchange } from "../auth/exchangeRuntime"
import { UsageGrantBootstrap } from "../auth/UsageGrantBootstrap"
import { classifyDeliveryResponse, type WireResponse } from "../contracts/classification"
import { USAGE_MINUTE_MS, USAGE_SECOND_MS, type UsageAttemptBodyWire } from "../contracts/usageBody"
import { DlineOtelHttpClient, type UsageDelivery, type UsageTransport } from "../transport/DlineOtelHttpClient"
import { UsageDeliveryWorker } from "../usage/UsageDeliveryWorker"
import { isOtelServiceMockAvailable, otelServiceMockEndpoint, readOtelServiceMockState } from "./support/OtelServiceMock"

const liveEndpoint = process.env.DLINE_OTEL_LIVE_ENDPOINT
const mockEndpoint = otelServiceMockEndpoint()
const mockAvailable = await isOtelServiceMockAvailable(mockEndpoint)
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

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("telemetry service contract", () => {
    it.skipIf(!mockAvailable)("holds against the independently hosted dline-web contract mock", async () => {
        const result = await runContractScenario(mockEndpoint)
        const state = await readOtelServiceMockState(mockEndpoint)
        const usage = state.accepted.filter((entry) => entry.path === "usage" && entry.request_id === result.requestId)

        expect(usage).toHaveLength(1)
        expect(usage[0]?.body).toEqual(result.body)
    })

    it.skipIf(!liveEndpoint)("holds against the explicitly configured live service", async () => {
        await runContractScenario(liveEndpoint as string)
    })
})

/**
 * Acquire schema 4 through the same recoverable composition production uses,
 * deliver one batch, then probe idempotency, request conflicts, gating and token rejection.
 */
async function runContractScenario(
    endpoint: string,
): Promise<{ readonly body: UsageAttemptBodyWire; readonly requestId: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-contract-"))
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
    const layout = resolveOtelStorageLayout(root)
    const client = new DlineOtelHttpClient({ clientVersion: VERSION, endpoint })
    const transport = new RecordingTransport(client)
    const credentials = new DeviceCredentialRepository(layout)
    const grantPort = deviceGrantPortFromRepository(credentials)
    const bootstrap = new UsageGrantBootstrap({
        port: grantPort,
        transport: client,
        clientVersion: VERSION,
        platform: process.platform,
    })
    const registry = new DeviceGrantPortRegistry(grantPort, bootstrap)
    installRecoverableExchange({
        registry,
        expectedBootstrap: bootstrap,
        repository: new ExchangeOperationRepository(layout),
        transport: client,
        clientVersion: VERSION,
        platform: process.platform,
    })
    const tokens = new DeviceTokenBroker({
        repository: credentials,
        transport: client,
        clientVersion: VERSION,
        platform: process.platform,
        grantClient: registry,
    })
    const acquired = await tokens.acquire("usage")
    expect(acquired.status).toBe("ready")
    if (acquired.status !== "ready") throw new Error("Schema 4 Usage grant was not issued")
    const start = Math.floor(Date.now() / USAGE_SECOND_MS) * USAGE_SECOND_MS + MINUTE
    const attemptId = randomUUID()
    const admittedAt = start + 1_000
    const durationMs = 2_500
    let now = admittedAt + durationMs
    await new UsageObservationSpool(layout, "contract-observer").appendAttempt({
        id: attemptId,
        revision: 1,
        receivedAt: now,
        observation: {
            attemptObservationId: attemptId,
            logicalRequestId: `logical-${attemptId}`,
            identity: {
                role: "task",
                provider: "anthropic",
                modelId: "catalog:claude-opus-4-1",
                thinking: 2_048,
            },
            policyGeneration: 1,
            admittedAt,
            outcome: "completed",
            durationMs,
            tokens: { input: 1_200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 0 },
            tokenUsageReported: true,
        },
    })
    const worker = new UsageDeliveryWorker({
        outbox: new UsageOutboxRepository(layout, { clock: () => now }),
        spool: new UsageObservationSpool(layout, "contract-sender"),
        tokens,
        transport,
        client: { version: VERSION, platform: process.platform, architecture: process.arch, is_dev: false },
        ownerId: "contract-sender",
        clock: () => now,
        readAttemptValidation: async () => {
            const grant = await credentials.readActiveDeviceGrant(now, "usage")
            return grant ? { contract: grant.usageContract, estimateWriteRows: () => 1 } : undefined
        },
    })

    now = start + 5_000
    await worker.runCycle(1)
    now = start + 10 * MINUTE + SETTLE
    let delivered = await worker.runCycle(1)
    for (let cycle = 0; cycle < 3 && delivered.kind === "idle"; cycle += 1) {
        now += 10 * MINUTE + SETTLE
        delivered = await worker.runCycle(1)
    }

    expect(delivered, JSON.stringify(delivered)).toMatchObject({ kind: "delivered", disposition: "accepted" })
    expect(transport.deliveries).toHaveLength(1)
    const first = transport.deliveries[0]
    if (!first) throw new Error("Usage delivery was not recorded")
    const sent = JSON.parse(new TextDecoder().decode(first.body)) as UsageAttemptBodyWire
    const duplicate = classifyDeliveryResponse(await client.sendUsage(first))
    expect(duplicate).toMatchObject({ kind: "acknowledged", disposition: "duplicate" })

    const altered = encode({ ...sent, client: { ...sent.client, version: `${sent.client.version}.conflict` } })
    expect(classifyDeliveryResponse(await client.sendUsage({ ...first, body: altered }))).toEqual({
        kind: "discard",
        code: "request_id_conflict",
    })

    const gated = classifyDeliveryResponse(await client.sendUsage({ ...first, requestId: randomUUID(), body: encode(sent) }))
    expect(gated).toMatchObject({ kind: "wait", code: "rate_limited" })

    const forged = await client.sendUsage({ ...first, accessToken: `${first.accessToken.slice(0, -4)}AAAA` })
    expect(classifyDeliveryResponse(forged)).toEqual({ kind: "refresh_token" })
    return { body: sent, requestId: first.requestId }
}

function encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
}
