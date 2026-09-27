import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { writeFileAtomic } from "@/shared/storage/atomic-file"
import { toOtlpLogRecord } from "../otel-semantics"
import type { RuntimeTelemetryEvent } from "../types"

/**
 * Append-only record of one extension host session's runtime events.
 *
 * A CPU or hang investigation happens after the fact, so the events must
 * outlive the in-memory bus. The journal is deliberately a plain JSON Lines
 * file: it survives a crashed host, can be truncated safely at line
 * boundaries, and needs no schema migration to read.
 *
 * Each line is an OTLP log record rather than the internal event shape, so a
 * standard collector can tail this directory with a `filelog` receiver and a
 * `json_parser` operator. Storing the private shape would have forced every
 * reader to carry a Dline-specific adapter to read data the collector already
 * knows how to interpret.
 *
 * Writing is best-effort. Diagnostics must never be the reason a task fails,
 * so every failure is counted rather than propagated.
 */

/** Keep a session's journal small enough to attach to a bug report. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Flush cadence. Batching avoids one syscall per recorded event. */
const DEFAULT_FLUSH_INTERVAL_MS = 2_000

export interface SessionJournalOptions {
	/** Directory that holds one file per session. */
	readonly directory: string
	readonly sessionId: string
	readonly maxBytes?: number
	readonly flushIntervalMs?: number
}

export interface SessionJournalStats {
	/** Events written to disk. */
	readonly written: number
	/** Events dropped because the journal could not persist them. */
	readonly failed: number
	/** Events discarded by truncation to stay inside the size budget. */
	readonly truncated: number
}

export class SessionJournal {
	readonly path: string

	private readonly maxBytes: number
	private readonly flushIntervalMs: number
	private readonly pending: string[] = []

	private stream: WriteStream | undefined
	private writtenBytes = 0
	private written = 0
	private failed = 0
	private truncated = 0
	private disposed = false
	private flushTimer: NodeJS.Timeout | undefined
	private flushing: Promise<void> | undefined

	constructor(options: SessionJournalOptions) {
		this.path = join(options.directory, `${options.sessionId}.jsonl`)
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
	}

	get stats(): SessionJournalStats {
		return { written: this.written, failed: this.failed, truncated: this.truncated }
	}

	/**
	 * Queue an event for persistence.
	 *
	 * Serialization happens here rather than at flush time so that a producer
	 * cannot mutate the event between recording and writing.
	 */
	append(event: RuntimeTelemetryEvent): void {
		if (this.disposed) return
		try {
			this.pending.push(JSON.stringify(toOtlpLogRecord(event)))
		} catch {
			// A payload that cannot be serialized is a producer defect; losing
			// one event is preferable to losing the journal.
			this.failed += 1
			return
		}
		this.scheduleFlush()
	}

	/** Write everything queued so far. Never rejects. */
	async flush(): Promise<void> {
		this.clearTimer()
		// Serialize flushes: two concurrent writers would interleave lines.
		this.flushing = (this.flushing ?? Promise.resolve()).then(() => this.writePending())
		return this.flushing
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		await this.flush()
		this.clearTimer()
		await this.closeStream()
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined
			void this.flush()
		}, this.flushIntervalMs)
		// The timer must not keep the extension host alive on shutdown.
		this.flushTimer.unref?.()
	}

	private clearTimer(): void {
		if (!this.flushTimer) return
		clearTimeout(this.flushTimer)
		this.flushTimer = undefined
	}

	private async writePending(): Promise<void> {
		if (this.pending.length === 0) return
		const batch = this.pending.splice(0, this.pending.length)
		const payload = `${batch.join("\n")}\n`

		try {
			const stream = await this.ensureStream()
			await new Promise<void>((resolve, reject) => {
				stream.write(payload, (error) => (error ? reject(error) : resolve()))
			})
			this.written += batch.length
			this.writtenBytes += Buffer.byteLength(payload)
			await this.enforceSizeBudget()
		} catch {
			this.failed += batch.length
		}
	}

	private async ensureStream(): Promise<WriteStream> {
		if (this.stream) return this.stream
		await mkdir(dirname(this.path), { recursive: true })
		const stream = createWriteStream(this.path, { flags: "a" })
		// A stream error without a listener would become an unhandled
		// exception in the extension host.
		stream.on("error", () => {
			this.failed += 1
		})
		this.stream = stream
		return stream
	}

	/**
	 * Drop the oldest lines once the file exceeds its budget.
	 *
	 * Truncation keeps the newest events because a diagnosis starts from the
	 * symptom, which is at the end of the session.
	 */
	private async enforceSizeBudget(): Promise<void> {
		if (this.writtenBytes <= this.maxBytes) return

		await this.closeStream()
		const raw = await readFile(this.path, "utf8")
		const lines = raw.split("\n").filter((line) => line.length > 0)

		let keptBytes = 0
		let firstKept = lines.length
		for (let index = lines.length - 1; index >= 0; index--) {
			const size = Buffer.byteLength(lines[index]) + 1
			if (keptBytes + size > this.maxBytes / 2) break
			keptBytes += size
			firstKept = index
		}

		// A single record can exceed the retention budget on its own. Dropping
		// everything would leave an empty journal at exactly the moment an
		// investigation needs the most recent event, so the newest line is
		// always kept even when it does not fit.
		if (firstKept === lines.length && lines.length > 0) {
			firstKept = lines.length - 1
			keptBytes = Buffer.byteLength(lines[firstKept]) + 1
		}

		const kept = lines.slice(firstKept)
		this.truncated += lines.length - kept.length
		await writeFileAtomic(this.path, kept.length > 0 ? `${kept.join("\n")}\n` : "")
		this.writtenBytes = keptBytes
	}

	private async closeStream(): Promise<void> {
		const stream = this.stream
		if (!stream) return
		this.stream = undefined
		await new Promise<void>((resolve) => stream.end(resolve))
	}
}
