import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXCEPTION_ATTRIBUTE_KEYS, RUNTIME_ATTRIBUTE_KEYS } from "../../otel-semantics"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../../types"
import { SessionJournal } from "../session-journal"

/**
 * The journal is the only durable record of a session's runtime events. These
 * tests pin the properties a later diagnosis depends on: the file stays
 * bounded, the newest events survive truncation, and a write failure never
 * escapes into the producer.
 */

function event(sequence: number, overrides: Partial<RuntimeTelemetryEvent> = {}): RuntimeTelemetryEvent {
    return {
        eventId: `event-${sequence}`,
        sequence,
        timestamp: 1_700_000_000_000 + sequence,
        monotonicMs: sequence,
        name: "task.phase",
        priority: RuntimeEventPriority.Info,
        context: { sessionId: "session-under-test" },
        attributes: { durationMs: sequence },
        ...overrides,
    }
}

async function readLines(path: string): Promise<string[]> {
    const raw = await readFile(path, "utf8")
    return raw.split("\n").filter((line) => line.length > 0)
}

/**
 * Reads the bus sequence back out of a journal line.
 *
 * Lines are OTLP log records, where ordering data lives in the attribute list
 * rather than at the top level, so a collector tailing this file needs no
 * Dline-specific adapter.
 */
async function readSequences(path: string): Promise<number[]> {
    const lines = await readLines(path)
    return lines.map((line) => {
        const record = JSON.parse(line)
        const attribute = record.attributes.find((entry: { key: string }) => entry.key === RUNTIME_ATTRIBUTE_KEYS.sequence)
        return Number(attribute.value.intValue)
    })
}

describe("SessionJournal persistence", () => {
    let directory: string
    let journal: SessionJournal

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "dline-journal-"))
        journal = new SessionJournal({ directory, sessionId: "session-under-test" })
    })

    afterEach(async () => {
        await journal.dispose()
        await rm(directory, { recursive: true, force: true })
    })

    it("writes one JSON line per event", async () => {
        journal.append(event(1))
        journal.append(event(2))
        await journal.flush()

        const lines = await readLines(journal.path)
        expect(lines).toHaveLength(2)
        expect(await readSequences(journal.path)).toEqual([1, 2])
    })

    it("preserves the recorded sequence so gaps stay visible", async () => {
        journal.append(event(4))
        journal.append(event(9))
        await journal.flush()

        const sequences = await readSequences(journal.path)
        expect(sequences).toEqual([4, 9])
    })

    it("keeps the newest events when the size budget is exceeded", async () => {
        const small = new SessionJournal({ directory, sessionId: "bounded", maxBytes: 400 })
        for (let sequence = 1; sequence <= 40; sequence++) {
            small.append(event(sequence))
        }
        await small.flush()

        const sequences = await readSequences(small.path)
        expect(sequences.length).toBeGreaterThan(0)
        expect(sequences.length).toBeLessThan(40)
        expect(sequences.at(-1)).toBe(40)
        await small.dispose()
    })

    it("keeps the newest record even when it alone exceeds the retention budget", async () => {
        // One OTLP record is ~380 bytes, so a budget this small cannot fit a
        // whole line. Truncating to nothing would empty the journal exactly
        // when an investigation needs the most recent event.
        const tiny = new SessionJournal({ directory, sessionId: "tiny", maxBytes: 100 })
        tiny.append(event(1))
        tiny.append(event(2))
        await tiny.flush()

        expect(await readSequences(tiny.path)).toEqual([2])
        await tiny.dispose()
    })

    it("counts events it could not persist instead of throwing", async () => {
        const broken = new SessionJournal({
            directory: join(directory, "missing", "\u0000invalid"),
            sessionId: "broken",
        })

        expect(() => broken.append(event(1))).not.toThrow()
        await expect(broken.flush()).resolves.toBeUndefined()
        expect(broken.stats.failed).toBeGreaterThan(0)
        await broken.dispose()
    })

    it("stops accepting events after disposal", async () => {
        journal.append(event(1))
        await journal.dispose()

        journal.append(event(2))
        await journal.flush()

        const sequences = await readSequences(journal.path)
        expect(sequences).toEqual([1])
    })
})

describe("SessionJournal content safety", () => {
    let directory: string

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "dline-journal-safety-"))
    })

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true })
    })

    it("persists only the fields the event contract defines", async () => {
        const journal = new SessionJournal({ directory, sessionId: "session-under-test" })
        journal.append(
            event(1, {
                attributes: { durationMs: 12, outcome: "success" },
                error: {
                    name: "Error",
                    message: "request failed",
                    code: "ERR_BAD_RESPONSE",
                    fingerprint: "error-fingerprint",
                },
            }),
        )
        await journal.flush()

        const [line] = await readLines(journal.path)
        const record = JSON.parse(line)

        // A collector tailing this file expects an OTLP log record, so the top
        // level carries only the fields that data model defines.
        expect(Object.keys(record).sort()).toEqual([
            "attributes",
            "body",
            "observedTimeUnixNano",
            "severityNumber",
            "severityText",
            "timeUnixNano",
        ])

        const attributeKeys = record.attributes.map((entry: { key: string }) => entry.key)
        expect(attributeKeys).toContain(RUNTIME_ATTRIBUTE_KEYS.sequence)
        expect(attributeKeys).toContain(EXCEPTION_ATTRIBUTE_KEYS.type)
        expect(JSON.stringify(record)).not.toContain("request failed")
        expect(JSON.stringify(record)).toContain("*****")
        // The session identifies the host run and belongs to the resource, so it
        // must not be repeated on every record.
        expect(attributeKeys).not.toContain("sessionId")
        await journal.dispose()
    })

    it("writes nanosecond timestamps as strings so they survive JSON", async () => {
        const journal = new SessionJournal({ directory, sessionId: "session-timestamps" })
        journal.append(event(1))
        await journal.flush()

        const [line] = await readLines(journal.path)
        const record = JSON.parse(line)

        expect(typeof record.timeUnixNano).toBe("string")
        // Proof the string encoding is required rather than a stylistic choice.
        expect(Number(record.timeUnixNano)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
        await journal.dispose()
    })
})
