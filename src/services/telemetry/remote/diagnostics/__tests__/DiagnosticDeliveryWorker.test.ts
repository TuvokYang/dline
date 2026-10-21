import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
    DIAGNOSTICS_PER_DAY,
    DIAGNOSTICS_PER_HOUR,
    DiagnosticOutboxRepository,
    MAX_DIAGNOSTICS_PER_REQUEST,
} from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { TokenAcquisition } from "../../auth/DeviceTokenBroker"
import type { WireResponse } from "../../contracts/classification"
import { GATE_MARGIN_MS } from "../../contracts/pacing"
import type { UsageDelivery } from "../../transport/DlineOtelHttpClient"
import { DlineOtelTransportError } from "../../transport/DlineOtelHttpClient"
import { DiagnosticDeliveryWorker } from "../DiagnosticDeliveryWorker"
import { type DiagnosticRecord, encodeDiagnosticLogs } from "../diagnosticRecord"

/** An hour boundary eight hours into a UTC day. */
const START = 1_800_000_000_000
const HOUR = 60 * 60_000
const RESOURCE = { clientVersion: "0.11.1", platform: "win32" }

function record(index: number, at = START): DiagnosticRecord {
    return {
        name: "task.provider_api_error",
        channel: "error",
        severity: "error",
        firstSeenMs: at,
        lastSeenMs: at,
        occurrences: 1,
        attributes: { "error.fingerprint": index.toString(16).padStart(16, "0") },
    }
}

const accepted = (nextEligibleAt?: number): WireResponse => ({
    status: 200,
    json: { ok: true, disposition: "accepted", ...(nextEligibleAt === undefined ? {} : { next_eligible_at: nextEligibleAt }) },
    retryAfter: null,
})

interface SentLogs {
    readonly requestId: string
    readonly body: string
    readonly records: { attributes: { key: string; value: { intValue?: string } }[] }[]
    readonly dropped: number
}

describe("DiagnosticDeliveryWorker (contract v2.1 §1.5-§1.7, §3.3)", () => {
    let root: string
    let now: number
    let sent: SentLogs[]
    let replies: (WireResponse | DlineOtelTransportError)[]

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-diagnostics-"))
        now = START
        sent = []
        replies = []
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function outbox(): DiagnosticOutboxRepository {
        return new DiagnosticOutboxRepository(path.join(root, "diagnostics", "outbox.json"), {
            encode: (records, dropped) => encodeDiagnosticLogs(records, RESOURCE, dropped),
            random: () => 0,
        })
    }

    function worker(tokens: TokenAcquisition[] = []): DiagnosticDeliveryWorker {
        return new DiagnosticDeliveryWorker({
            outbox: outbox(),
            owner: "window-a",
            clock: () => now,
            tokens: {
                acquire: async () =>
                    tokens.shift() ?? {
                        status: "ready",
                        token: { accessToken: "token", deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER, obtainedAt: 0 },
                    },
            },
            transport: {
                sendLogs: async (delivery: UsageDelivery) => {
                    const text = new TextDecoder().decode(delivery.body)
                    const body = JSON.parse(text)
                    const [resourceLogs] = body.resourceLogs
                    const dropped = resourceLogs.resource.attributes.find(
                        (attribute: { key: string }) => attribute.key === "dline.dropped_records",
                    )
                    sent.push({
                        requestId: delivery.requestId,
                        body: text,
                        records: resourceLogs.scopeLogs[0].logRecords,
                        dropped: Number(dropped?.value.intValue),
                    })
                    const reply = replies.shift() ?? accepted()
                    if (reply instanceof DlineOtelTransportError) throw reply
                    return reply
                },
            },
        })
    }

    it("starts no new batch before the gate the service named; the next one carries everything gathered since", async () => {
        replies.push(accepted(START + HOUR))
        await outbox().append([record(1)], now)
        await worker().deliverOnce()
        await outbox().append([record(2), record(3)], now)

        now = START + HOUR
        await worker().deliverOnce()
        now = START + HOUR + GATE_MARGIN_MS
        await worker().deliverOnce()

        expect(sent.map((request) => request.records.length)).toEqual([1, 2])
    })

    it("replays the same id and bytes after an unknown outcome, only once the backoff passed", async () => {
        replies.push(new DlineOtelTransportError("timeout"))
        await outbox().append([record(1)], now)

        await worker().deliverOnce()
        now += 29_999
        await worker().deliverOnce()
        now += 1
        await worker().deliverOnce()

        expect(sent).toHaveLength(2)
        expect(sent[1].requestId).toBe(sent[0].requestId)
    })

    it("on a pause sends nothing until it ends, then replays the same batch first; records gathered meanwhile form their own", async () => {
        replies.push({
            status: 429,
            json: { ok: false, error: { code: "telemetry_paused" }, retry_after_ms: 2 * HOUR },
            retryAfter: null,
        })
        await outbox().append([record(1)], now)
        await worker().deliverOnce()
        await outbox().append([record(1, now + 1_000), record(2, now + 1_000)], now + 1_000)

        now = START + 2 * HOUR - 1
        await worker().deliverOnce()
        now = START + 2 * HOUR
        replies.push(accepted(now))
        await worker().deliverOnce()
        now += GATE_MARGIN_MS
        await worker().deliverOnce()

        expect(sent).toHaveLength(3)
        expect(sent[1].requestId).toBe(sent[0].requestId)
        expect(sent[1].body).toBe(sent[0].body)
        expect(sent[2].requestId).not.toBe(sent[0].requestId)
        const occurrences = sent[2].records.map(
            (entry) => entry.attributes.find((attribute) => attribute.key === "dline.occurrences")?.value.intValue,
        )
        expect(occurrences).toEqual(["1", "1"])
    })

    it("after a timeout and a 429, replays the same bytes and takes a duplicate as delivered without sending it again", async () => {
        replies.push(
            new DlineOtelTransportError("timeout"),
            { status: 429, json: undefined, retryAfter: null },
            {
                status: 200,
                json: { ok: true, disposition: "duplicate" },
                retryAfter: null,
            },
        )
        await outbox().append([record(1)], now)

        await worker().deliverOnce()
        now += 30_000
        await worker().deliverOnce()
        now += 59_999
        await worker().deliverOnce()
        now += 1
        await worker().deliverOnce()
        now += 2 * HOUR
        await worker().deliverOnce()

        const document = await outbox().read()
        expect(sent).toHaveLength(3)
        expect(new Set(sent.map((request) => request.requestId)).size).toBe(1)
        expect(new Set(sent.map((request) => request.body)).size).toBe(1)
        expect(document.inflight).toBeUndefined()
        expect(document.records).toEqual([])
        expect(document.dropped).toBe(0)
    })

    it("counts neither a 429 as a replay nor its wait against the 24-hour limit", async () => {
        replies.push(
            new DlineOtelTransportError("timeout"),
            {
                status: 429,
                json: { ok: false, error: { code: "telemetry_paused" }, retry_after_ms: 30 * HOUR },
                retryAfter: null,
            },
            new DlineOtelTransportError("timeout"),
        )
        await outbox().append([record(1)], now)

        await worker().deliverOnce()
        now += 30_000
        await worker().deliverOnce()
        now = (await outbox().read()).pacing.wait_until
        await worker().deliverOnce()

        const document = await outbox().read()
        expect(now - START).toBeGreaterThan(24 * HOUR)
        expect(sent).toHaveLength(3)
        expect(document.inflight).toMatchObject({ request_id: sent[0].requestId, attempts: 2 })
        expect(document.dropped).toBe(0)
    })

    it("keeps waiting on logs without holding usage, whose outbox is its own", async () => {
        replies.push({ status: 429, json: undefined, retryAfter: null })
        await outbox().append([record(1)], now)
        await worker().deliverOnce()

        const usage = new UsageOutboxRepository(resolveOtelStorageLayout(path.join(root, "data")), { clock: () => now })
        const grant = await usage.claim("window-a")

        expect((await outbox().read()).pacing.wait_until).toBe(START + 60_000)
        expect(grant).toBeDefined()
        expect((await usage.read())?.pacing.waitUntil ?? 0).toBe(0)
    })

    it("on 413 resends the first half at once under a new id and returns the rest to the queue", async () => {
        replies.push({ status: 413, json: { ok: false, error: { code: "payload_too_large" } }, retryAfter: null })
        await outbox().append(
            [1, 2, 3, 4].map((index) => record(index)),
            now,
        )

        await worker().deliverOnce()
        await worker().deliverOnce()

        expect(sent.map((request) => request.records.length)).toEqual([4, 2])
        expect(sent[1].requestId).not.toBe(sent[0].requestId)
        expect((await outbox().read()).records).toHaveLength(2)
    })

    it("drops a batch refused with 422 without retrying, and reports it as dropped in the next request", async () => {
        replies.push({ status: 422, json: { ok: false, error: { code: "invalid_logs" } }, retryAfter: null })
        await outbox().append([record(1), record(2)], now)
        await worker().deliverOnce()
        await outbox().append([record(3)], now)

        now += 5 * 60_000
        await worker().deliverOnce()

        expect(sent).toHaveLength(2)
        expect(sent[1].dropped).toBe(2)
        expect(sent[1].records).toHaveLength(1)
    })

    it("keeps 50 new records an hour and 200 a day, counting the rest in dline.dropped_records", async () => {
        for (let hour = 0; hour < 5; hour++) {
            const at = START + hour * HOUR
            await outbox().append(
                Array.from({ length: DIAGNOSTICS_PER_HOUR + 5 }, (_, index) => record(hour * 1_000 + index, at)),
                at,
            )
        }
        // A repeat of an admitted record still merges after the limit is reached.
        await outbox().append([record(0, START + 4 * HOUR)], START + 4 * HOUR)

        const document = await outbox().read()

        expect(document.records).toHaveLength(DIAGNOSTICS_PER_DAY)
        expect(document.dropped).toBe(4 * 5 + (DIAGNOSTICS_PER_HOUR + 5))
        expect(document.records[0].occurrences).toBe(2)

        now = START + 5 * HOUR
        await worker().deliverOnce()
        expect(sent[0].records).toHaveLength(MAX_DIAGNOSTICS_PER_REQUEST)
        expect(sent[0].dropped).toBe(document.dropped)
    })

    it("exchanges the token once after a 401 and stops when the fresh one is refused too", async () => {
        const unauthorized: WireResponse = {
            status: 401,
            json: { ok: false, error: { code: "token_expired" } },
            retryAfter: null,
        }
        replies.push(unauthorized, unauthorized)
        await outbox().append([record(1)], now)

        await worker().deliverOnce()
        now += 60_000
        await worker().deliverOnce()

        expect(sent).toHaveLength(2)
        expect((await outbox().read()).stop?.code).toBe("token_rejected")
    })
})
