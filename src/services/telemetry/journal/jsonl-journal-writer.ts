import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { writeFileAtomic } from "@/shared/storage/atomic-file"

export type JournalSignalFile = "usage" | "metrics" | "traces"

export interface JsonlJournalWriterStats {
    readonly written: number
    readonly failed: number
    readonly truncated: number
    readonly partialTailRecovered: number
    readonly sequenceGaps: number
}

export interface JournalRecoveryResult {
    readonly facts: readonly JournalRecoveryFact[]
    readonly lastSequences: Readonly<Record<JournalSignalFile, number>>
}

export interface JournalRecoveryFact {
    readonly kind: "journal.partial_tail_recovered" | "journal.sequence_gap"
    readonly file: JournalSignalFile
    readonly expected?: number
    readonly observed?: number
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_FLUSH_INTERVAL_MS = 2_000

/** Bounded, best-effort JSONL writer shared by usage, metric and trace projections. */
export class JsonlJournalWriter {
    readonly paths: Readonly<Record<JournalSignalFile, string>>
    private readonly pending = new Map<JournalSignalFile, string[]>()
    private readonly writtenBytes = new Map<JournalSignalFile, number>()
    private readonly maxBytes: number
    private readonly flushIntervalMs: number
    private flushTimer: NodeJS.Timeout | undefined
    private flushing: Promise<void> = Promise.resolve()
    private disposed = false
    private written = 0
    private failed = 0
    private truncated = 0
    private partialTailRecovered = 0
    private sequenceGaps = 0

    constructor(options: {
        readonly directory: string
        readonly sessionId: string
        readonly maxBytes?: number
        readonly flushIntervalMs?: number
    }) {
        this.paths = {
            usage: join(options.directory, `usage-${options.sessionId}.jsonl`),
            metrics: join(options.directory, `metrics-${options.sessionId}.jsonl`),
            traces: join(options.directory, `traces-${options.sessionId}.jsonl`),
        }
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
        this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    }

    get stats(): JsonlJournalWriterStats {
        return {
            written: this.written,
            failed: this.failed,
            truncated: this.truncated,
            partialTailRecovered: this.partialTailRecovered,
            sequenceGaps: this.sequenceGaps,
        }
    }

    append(file: JournalSignalFile, record: unknown): void {
        if (this.disposed) return
        try {
            const batch = this.pending.get(file) ?? []
            batch.push(JSON.stringify(record))
            this.pending.set(file, batch)
            this.scheduleFlush()
        } catch {
            this.failed += 1
        }
    }

    async recover(): Promise<JournalRecoveryResult> {
        const facts: JournalRecoveryFact[] = []
        const lastSequences: Record<JournalSignalFile, number> = { usage: 0, metrics: 0, traces: 0 }
        for (const file of ["usage", "metrics", "traces"] as const) {
            const path = this.paths[file]
            let raw: string
            try {
                raw = await readFile(path, "utf8")
            } catch {
                continue
            }
            if (raw.length > 0 && !raw.endsWith("\n")) {
                const lastComplete = raw.lastIndexOf("\n")
                raw = lastComplete >= 0 ? raw.slice(0, lastComplete + 1) : ""
                await writeFile(path, raw, "utf8")
                this.partialTailRecovered += 1
                facts.push({ kind: "journal.partial_tail_recovered", file })
            }
            this.writtenBytes.set(file, Buffer.byteLength(raw))
            let previous: number | undefined
            for (const line of raw.split("\n").filter(Boolean)) {
                try {
                    const sequence = sequenceOf(JSON.parse(line))
                    if (sequence !== undefined && previous !== undefined && sequence > previous + 1) {
                        this.sequenceGaps += 1
                        facts.push({ kind: "journal.sequence_gap", file, expected: previous + 1, observed: sequence })
                    }
                    if (sequence !== undefined) {
                        previous = sequence
                        lastSequences[file] = Math.max(lastSequences[file], sequence)
                    }
                } catch {
                    // Complete but invalid historical lines are left untouched for forensic inspection.
                }
            }
        }
        return { facts, lastSequences }
    }

    async flush(): Promise<void> {
        this.clearTimer()
        this.flushing = this.flushing.then(() => this.writePending())
        await this.flushing
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        await this.flush()
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined
            void this.flush()
        }, this.flushIntervalMs)
        this.flushTimer.unref?.()
    }

    private clearTimer(): void {
        if (!this.flushTimer) return
        clearTimeout(this.flushTimer)
        this.flushTimer = undefined
    }

    private async writePending(): Promise<void> {
        for (const file of ["usage", "metrics", "traces"] as const) {
            const batch = this.pending.get(file)?.splice(0) ?? []
            if (batch.length === 0) continue
            const payload = `${batch.join("\n")}\n`
            try {
                const path = this.paths[file]
                await mkdir(dirname(path), { recursive: true })
                await appendFile(path, payload, "utf8")
                this.written += batch.length
                this.writtenBytes.set(file, (this.writtenBytes.get(file) ?? 0) + Buffer.byteLength(payload))
                await this.enforceSizeBudget(file)
            } catch {
                this.failed += batch.length
            }
        }
    }

    private async enforceSizeBudget(file: JournalSignalFile): Promise<void> {
        if ((this.writtenBytes.get(file) ?? 0) <= this.maxBytes) return
        const path = this.paths[file]
        const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean)
        let keptBytes = 0
        let firstKept = lines.length
        for (let index = lines.length - 1; index >= 0; index--) {
            const size = Buffer.byteLength(lines[index]) + 1
            if (keptBytes + size > this.maxBytes / 2) break
            keptBytes += size
            firstKept = index
        }
        if (firstKept === lines.length && lines.length > 0) {
            firstKept = lines.length - 1
            keptBytes = Buffer.byteLength(lines[firstKept]) + 1
        }
        const kept = lines.slice(firstKept)
        this.truncated += lines.length - kept.length
        await writeFileAtomic(path, kept.length > 0 ? `${kept.join("\n")}\n` : "")
        this.writtenBytes.set(file, keptBytes)
    }
}

function sequenceOf(record: unknown): number | undefined {
    if (!record || typeof record !== "object") return undefined
    const attributes =
        (record as { resourceLogs?: ResourceGroup[]; resourceMetrics?: ResourceGroup[]; resourceSpans?: ResourceGroup[] })
            .resourceLogs?.[0]?.resource?.attributes ??
        (record as { resourceMetrics?: ResourceGroup[] }).resourceMetrics?.[0]?.resource?.attributes ??
        (record as { resourceSpans?: ResourceGroup[] }).resourceSpans?.[0]?.resource?.attributes
    const entry = attributes?.find((attribute) => attribute.key === "dline.sequence")
    const value = entry?.value?.intValue ?? entry?.value?.stringValue
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
}

interface ResourceGroup {
    readonly resource?: {
        readonly attributes?: readonly {
            readonly key: string
            readonly value?: { readonly intValue?: number; readonly stringValue?: string }
        }[]
    }
}
