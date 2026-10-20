import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { DiagnosticRecord } from "@/services/telemetry/remote/diagnostics/diagnosticRecord"
import {
    DIAGNOSTICS_PER_HOUR,
    type DiagnosticEncoder,
    DiagnosticOutboxRepository,
    MAX_DIAGNOSTICS_REQUEST_BYTES,
} from "../DiagnosticOutboxRepository"

const START = 1_800_000_000_000
const HOUR = 60 * 60_000

function record(index: number): DiagnosticRecord {
    return {
        name: "task.provider_api_error",
        channel: "error",
        severity: "error",
        firstSeenMs: START,
        lastSeenMs: START,
        occurrences: 1,
        attributes: { "error.fingerprint": index.toString(16).padStart(16, "0") },
    }
}

/** Every record weighs 3 KiB, so a full hour of records cannot travel in one request. */
const heavyEncoder: DiagnosticEncoder = (records, dropped) =>
    JSON.stringify({ dropped, records: records.map((entry) => ({ ...entry, pad: "x".repeat(3 * 1024) })) })

describe("DiagnosticOutboxRepository", () => {
    let root: string
    let filePath: string

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-diagnostic-outbox-"))
        filePath = path.join(root, "diagnostics", "outbox.json")
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("keeps one request within 128 KiB by sending fewer records, leaving the rest queued", async () => {
        const outbox = new DiagnosticOutboxRepository(filePath, { encode: heavyEncoder })
        await outbox.append(
            Array.from({ length: DIAGNOSTICS_PER_HOUR }, (_, index) => record(index)),
            START,
        )

        const claimed = await outbox.claim("window-a", START)

        expect(claimed).toBeDefined()
        const body = claimed?.body ?? ""
        const sent = (JSON.parse(body) as { records: unknown[] }).records.length
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTICS_REQUEST_BYTES)
        expect(sent).toBeGreaterThan(0)
        expect(sent).toBeLessThan(DIAGNOSTICS_PER_HOUR)
        expect((await outbox.read()).records).toHaveLength(DIAGNOSTICS_PER_HOUR - sent)
    })

    it("forgets queued records when reporting is withdrawn, but keeps a running wait and the hourly count", async () => {
        const outbox = new DiagnosticOutboxRepository(filePath, { encode: heavyEncoder, random: () => 0 })
        await outbox.append([record(1), record(2), record(3)], START)
        const claimed = await outbox.claim("window-a", START)
        await outbox.settle("window-a", claimed?.requestId ?? "", { kind: "wait", retryAfterMs: 2 * HOUR }, START)

        await outbox.clear()
        const cleared = await outbox.read()

        expect(cleared.records).toEqual([])
        expect(cleared.inflight).toBeUndefined()
        expect(cleared.pacing.wait_until).toBe(START + 2 * HOUR)
        expect(cleared.quota.hour_count).toBe(3)
        // Turning reporting back on cannot send before the wait ends.
        await outbox.append([record(4)], START + HOUR)
        expect(await outbox.claim("window-a", START + HOUR)).toBeUndefined()
        expect(await outbox.claim("window-a", START + 2 * HOUR)).toBeDefined()
    })

    it("reports records the caller had to drop before they reached the outbox", async () => {
        const outbox = new DiagnosticOutboxRepository(filePath, { encode: heavyEncoder })

        await outbox.append([record(1)], START, 4)

        expect((await outbox.read()).dropped).toBe(4)
    })

    it("never rewrites a document a newer build wrote", async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const newer = JSON.stringify({ schema_version: 3, records: ["kept as is"] })
        await fs.writeFile(filePath, newer)
        const outbox = new DiagnosticOutboxRepository(filePath, { encode: heavyEncoder })

        await outbox.append([record(1)], START)

        expect(await outbox.claim("window-a", START)).toBeUndefined()
        expect(await fs.readFile(filePath, "utf8")).toBe(newer)
    })
})
