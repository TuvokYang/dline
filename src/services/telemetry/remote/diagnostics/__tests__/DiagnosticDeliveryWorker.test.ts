import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { StoredDeviceToken } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import {
    DIAGNOSTICS_CLAIM_TTL_MS,
    DIAGNOSTICS_STOP_RETRY_MS,
    DiagnosticOutboxRepository,
    MAX_DIAGNOSTICS_PER_REQUEST,
    MAX_PENDING_DIAGNOSTICS,
} from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import type { TokenAcquisition } from "../../auth/DeviceTokenBroker"
import type { WireResponse } from "../../contracts/classification"
import type { UsageDelivery } from "../../transport/DlineOtelHttpClient"
import { DIAGNOSTICS_RETRY_MS, DiagnosticDeliveryWorker } from "../DiagnosticDeliveryWorker"
import type { DiagnosticRecord } from "../diagnosticRecord"

const START = 1_800_000_000_000
const RESOURCE = { clientVersion: "0.11.0", platform: "linux" }

function record(index: number): DiagnosticRecord {
    return { timeUnixMs: START + index, name: `task.failure_${index}`, channel: "error", severity: "error", attributes: {} }
}

function ready(accessToken: string): TokenAcquisition {
    return { status: "ready", token: { accessToken } as StoredDeviceToken }
}

const ok = (): WireResponse => ({ status: 200, json: { ok: true, accepted: 1, rejected: 0 }, retryAfter: null })
const failure = (status: number, code: string, retryAfter: string | null = null): WireResponse => ({
    status,
    json: { ok: false, error: { code, message: "x" } },
    retryAfter,
})

/** Names of the records inside one sent OTLP body. */
function namesIn(body: Uint8Array): string[] {
    const request = JSON.parse(new TextDecoder().decode(body)) as {
        resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[]
    }
    return request.resourceLogs[0].scopeLogs[0].logRecords.map((log) => log.body.stringValue)
}

describe("diagnostic outbox and delivery", () => {
    let root: string
    let outbox: DiagnosticOutboxRepository
    let now: number
    let sent: UsageDelivery[]
    let responses: (WireResponse | Error)[]
    let acquisitions: TokenAcquisition[]
    let acquireCalls: { rejectedAccessToken?: string }[]

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-diagnostics-"))
        outbox = new DiagnosticOutboxRepository(path.join(root, "diagnostics", "outbox.json"))
        now = START
        sent = []
        responses = []
        acquisitions = []
        acquireCalls = []
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function worker(owner = "window-a"): DiagnosticDeliveryWorker {
        return new DiagnosticDeliveryWorker({
            outbox,
            owner,
            resource: RESOURCE,
            clock: () => now,
            tokens: {
                acquire: async (_profile, options) => {
                    acquireCalls.push({ rejectedAccessToken: options?.rejectedAccessToken })
                    return acquisitions.shift() ?? ready("token-default")
                },
            },
            transport: {
                sendLogs: async (delivery) => {
                    sent.push(delivery)
                    const next = responses.shift() ?? ok()
                    if (next instanceof Error) throw next
                    return next
                },
            },
        })
    }

    it("sends queued records once and leaves nothing behind after the service confirms them", async () => {
        await outbox.append([record(1), record(2)])
        await worker().deliverOnce()
        await worker().deliverOnce()

        expect(sent).toHaveLength(1)
        expect(namesIn(sent[0].body)).toEqual(["task.failure_1", "task.failure_2"])
        expect(await outbox.read()).toMatchObject({ records: [] })
        expect((await outbox.read()).inflight).toBeUndefined()
    })

    it("splits a backlog into requests of at most 256 records, oldest first", async () => {
        await outbox.append(Array.from({ length: MAX_DIAGNOSTICS_PER_REQUEST + 10 }, (_, index) => record(index)))
        await worker().deliverOnce()
        await worker().deliverOnce()

        expect(sent.map((delivery) => namesIn(delivery.body).length)).toEqual([MAX_DIAGNOSTICS_PER_REQUEST, 10])
        expect(namesIn(sent[1].body)[0]).toBe(`task.failure_${MAX_DIAGNOSTICS_PER_REQUEST}`)
    })

    it("resends the same request id and bytes after a failure, not a new batch with later records", async () => {
        await outbox.append([record(1)])
        responses.push(new Error("socket hang up"))
        await worker().deliverOnce()
        await outbox.append([record(2)])

        now += DIAGNOSTICS_RETRY_MS - 1
        await worker().deliverOnce()
        expect(sent).toHaveLength(1)

        now += 1
        await worker().deliverOnce()
        expect(sent).toHaveLength(2)
        expect(sent[1].requestId).toBe(sent[0].requestId)
        expect(sent[1].body).toEqual(sent[0].body)

        await worker().deliverOnce()
        expect(namesIn(sent[2].body)).toEqual(["task.failure_2"])
        expect(sent[2].requestId).not.toBe(sent[0].requestId)
    })

    it("waits as long as a rate limit asks before replaying", async () => {
        await outbox.append([record(1)])
        responses.push(failure(429, "rate_limited", "120"))
        await worker().deliverOnce()

        now += 119_000
        await worker().deliverOnce()
        expect(sent).toHaveLength(1)
        now += 1_000
        await worker().deliverOnce()
        expect(sent.map((delivery) => delivery.requestId)).toEqual([sent[0].requestId, sent[0].requestId])
    })

    it("exchanges a rejected token once and resends the batch with the new one", async () => {
        await outbox.append([record(1)])
        acquisitions.push(ready("token-old"), ready("token-new"))
        responses.push(failure(401, "token_expired"), ok())
        await worker().deliverOnce()

        expect(sent.map((delivery) => delivery.accessToken)).toEqual(["token-old", "token-new"])
        expect(acquireCalls).toEqual([{ rejectedAccessToken: undefined }, { rejectedAccessToken: "token-old" }])
        expect((await outbox.read()).inflight).toBeUndefined()
    })

    it("stops every window for 30 minutes when the service refuses the stream, then retries the same batch", async () => {
        await outbox.append([record(1)])
        responses.push(failure(403, "diagnostic_profile_required"))
        await worker("window-a").deliverOnce()
        expect((await outbox.read()).stop?.code).toBe("diagnostic_profile_required")

        now += DIAGNOSTICS_STOP_RETRY_MS - 1
        await worker("window-b").deliverOnce()
        expect(sent).toHaveLength(1)

        now += 1
        await worker("window-b").deliverOnce()
        expect(sent).toHaveLength(2)
        expect(sent[1].requestId).toBe(sent[0].requestId)
        expect((await outbox.read()).stop).toBeUndefined()
    })

    it("sends nothing while no token is available and tries again when the broker says", async () => {
        await outbox.append([record(1)])
        acquisitions.push({ status: "deferred", retryAt: START + 5_000, reason: "enrollment_backoff" })
        await worker().deliverOnce()
        expect(sent).toHaveLength(0)

        now = START + 4_999
        await worker().deliverOnce()
        expect(sent).toHaveLength(0)
        now = START + 5_000
        await worker().deliverOnce()
        expect(sent).toHaveLength(1)
    })

    it("drops a batch the service refuses for good instead of resending it", async () => {
        await outbox.append([record(1)])
        responses.push(failure(409, "idempotency_conflict"))
        await worker().deliverOnce()
        await worker().deliverOnce()

        expect(sent).toHaveLength(1)
        expect((await outbox.read()).inflight).toBeUndefined()
    })

    it("lets another window take over a batch only after the first window's claim expires", async () => {
        await outbox.append([record(1)])
        const encode = () => "{}"
        const first = await outbox.claim("window-a", now, encode)
        expect(await outbox.claim("window-b", now + DIAGNOSTICS_CLAIM_TTL_MS - 1, encode)).toBeUndefined()
        const second = await outbox.claim("window-b", now + DIAGNOSTICS_CLAIM_TTL_MS, encode)
        expect(second).toEqual(first)
    })

    it("keeps the newest records when the backlog overflows and counts what it dropped", async () => {
        await outbox.append(Array.from({ length: MAX_PENDING_DIAGNOSTICS + 3 }, (_, index) => record(index)))
        const document = await outbox.read()
        expect(document.records).toHaveLength(MAX_PENDING_DIAGNOSTICS)
        expect(document.records[0].name).toBe("task.failure_3")
        expect(document.dropped).toBe(3)
    })

    it("forgets every waiting record when cleared", async () => {
        await outbox.append([record(1)])
        responses.push(failure(500, "internal_error"))
        await worker().deliverOnce()
        await outbox.clear()

        now += DIAGNOSTICS_RETRY_MS
        await worker().deliverOnce()
        expect(sent).toHaveLength(1)
        expect(await outbox.read()).toMatchObject({ records: [], dropped: 0 })
    })
})
