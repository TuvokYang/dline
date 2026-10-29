import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TELEMETRY_MASK_VALUE } from "../runtime/content-policy"
import { LocalJournalProvider } from "./LocalJournalProvider"

const SESSION_ID = "journal-session"

function resourceRecord(sequence: number): string {
    return JSON.stringify({
        resourceLogs: [
            {
                resource: {
                    attributes: [{ key: "dline.sequence", value: { intValue: String(sequence) } }],
                },
                scopeLogs: [],
            },
        ],
    })
}

describe("LocalJournalProvider", () => {
    let directory: string

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "dline-local-journal-"))
    })

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true })
    })

    it("does not create the journal directory until an authorised signal is appended", async () => {
        const journalDirectory = join(directory, "telemetry", "sessions")
        const provider = await LocalJournalProvider.create({ directory: journalDirectory, sessionId: SESSION_ID })

        expect(existsSync(journalDirectory)).toBe(false)
        await provider.dispose()
        expect(existsSync(journalDirectory)).toBe(false)
    })

    it("writes canonical Event, Metric and Trace OTLP JSON with field-preserving masks", async () => {
        const provider = await LocalJournalProvider.create({
            directory,
            sessionId: SESSION_ID,
            fingerprintKey: Buffer.alloc(32, 3),
            flushIntervalMs: 0,
        })
        provider.append({
            kind: "event",
            channel: "usage",
            severity: "info",
            name: "task.started",
            required: false,
            properties: {
                user_name: "Alice",
                userId: "user-canary",
                organization_id: "org-canary",
                nested: { prompt: "prompt-canary", outcome: "success" },
            },
        })
        provider.append({
            kind: "metric",
            channel: "runtime",
            severity: "info",
            instrument: "histogram",
            name: "dline.runtime.operation.duration",
            value: 12,
            attributes: { operation: "tool.execution" },
        })
        const span = provider.startSpan({ name: "tool.execution", attributes: { taskId: "task-canary", tool: "read_file" } })
        span.recordException(new TypeError("must-not-persist"))
        span.end("failure")
        await provider.forceFlush()

        const usage = readFileSync(provider.paths.usage, "utf8")
        const metrics = readFileSync(provider.paths.metrics, "utf8")
        const traces = readFileSync(provider.paths.traces, "utf8")
        const combined = `${usage}\n${metrics}\n${traces}`
        expect(combined).not.toContain("Alice")
        expect(combined).not.toContain("user-canary")
        expect(combined).not.toContain("org-canary")
        expect(combined).not.toContain("prompt-canary")
        expect(combined).not.toContain("must-not-persist")
        expect(combined).toContain(`"stringValue":"${TELEMETRY_MASK_VALUE}"`)
        expect(combined).toContain("userId")
        expect(combined).toContain("organization_id")
        expect(combined).toContain("taskId")
        expect(combined).toContain("nested.prompt")
        expect(combined).toContain("nested.outcome")
        expect(JSON.parse(usage.trim())).toHaveProperty("resourceLogs")
        expect(JSON.parse(metrics.trim())).toHaveProperty("resourceMetrics")
        expect(JSON.parse(traces.trim())).toHaveProperty("resourceSpans")
        await provider.dispose()
    })

    it("repairs an incomplete tail, reports a sequence gap, and resumes after the last sequence", async () => {
        const path = join(directory, `usage-${SESSION_ID}.jsonl`)
        writeFileSync(path, `${resourceRecord(1)}\n${resourceRecord(3)}\n{"partial":`, "utf8")

        const provider = await LocalJournalProvider.create({ directory, sessionId: SESSION_ID, flushIntervalMs: 0 })
        provider.append({ kind: "event", channel: "runtime", severity: "info", name: "runtime.ready", required: false })
        await provider.forceFlush()

        const raw = readFileSync(path, "utf8")
        expect(raw).not.toContain('{"partial":')
        expect(raw).toContain("journal.partial_tail_recovered")
        expect(raw).toContain("journal.sequence_gap")
        expect(raw).toContain("runtime.ready")
        expect(provider.stats.partialTailRecovered).toBe(1)
        expect(provider.stats.sequenceGaps).toBe(1)
        await provider.dispose()
    })
})
