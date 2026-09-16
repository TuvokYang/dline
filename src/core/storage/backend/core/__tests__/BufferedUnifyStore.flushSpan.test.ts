import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { SignalSpanHandle } from "@/services/telemetry/service/pipeline-port"
import { installObservabilityPipeline } from "@/services/telemetry/service/pipeline-port"
import { runInSpanScope } from "@/services/telemetry/service/trace-scope"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

/**
 * Behavior guard for the storage flush span.
 *
 * A commit against a large history is one of the places a task visibly stalls,
 * and the waterfall is where that shows up as a step rather than as unexplained
 * time inside the caller.
 *
 * The span is deliberately conditional. A buffered store also flushes from a
 * repeating timer, and a span started there would have no caller to attribute
 * the work to: it would emit a root trace every interval for every open store
 * and explain nothing. Both halves are pinned here because the conditional is
 * exactly the part that could regress unnoticed.
 */

interface Row {
	ts: number
	value: string
}

interface RecordedSpan {
	name: string
	parent?: string
	attributes: Record<string, unknown>
	outcome?: string
	ended: boolean
}

const spans: RecordedSpan[] = []
const roots: string[] = []

/** Minimal span handle; only the fields the store actually uses. */
function fakeSpan(name: string, record: RecordedSpan): SignalSpanHandle {
	return {
		active: true,
		spanContext: { traceId: "trace", spanId: name, traceFlags: 1 },
		run: <T>(action: () => T): T => action(),
		setAttribute: (key: string, value: string | number | boolean) => {
			record.attributes[key] = value
		},
		recordException: () => {},
		end: (outcome?: "success" | "failure" | "cancelled") => {
			record.outcome = outcome
			record.ended = true
		},
	}
}

function createFixturePath(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "dline-flush-span-"))
	roots.push(root)
	return path.join(root, "rows.jsonl")
}

/**
 * Open a store whose only flush is the one the test performs.
 *
 * The production default is one second. Leaving it in place would let the
 * periodic flush clear the pending write during any pause between `append()`
 * and the explicit flush, after which the explicit flush would find nothing to
 * commit and open no span — a failure that depends on machine load rather than
 * on the behavior under test.
 */
function openStore(filePath: string) {
	return openBufferedJsonlStore<Row>(filePath, { schemaId: "flush-span", flushIntervalMs: 60_000 })
}

installObservabilityPipeline({
	recordHistogram: () => {},
	recordGauge: () => {},
	startSpan: (options) => {
		const record: RecordedSpan = {
			name: options.name,
			parent: (options.parent as { spanContext?: { spanId: string } } | undefined)?.spanContext?.spanId,
			attributes: { ...options.attributes },
			ended: false,
		}
		spans.push(record)
		return fakeSpan(options.name, record)
	},
})

beforeEach(() => {
	spans.length = 0
})

afterAll(() => {
	installObservabilityPipeline(undefined)
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function flushSpans(): RecordedSpan[] {
	return spans.filter((entry) => entry.name === "storage.flush_commit")
}

describe("BufferedUnifyStore flush span", () => {
	it("hangs the commit under the operation waiting on it", async () => {
		const store = await openStore(createFixturePath())
		const parentRecord: RecordedSpan = { name: "caller", attributes: {}, ended: false }
		const parent = fakeSpan("caller", parentRecord)

		try {
			await store.append({ ts: 10, value: "a" })
			await runInSpanScope(parent, () => store.flush())

			expect(flushSpans()).toHaveLength(1)
			expect(flushSpans()[0]?.parent).toBe("caller")
			expect(flushSpans()[0]?.outcome).toBe("success")
			expect(flushSpans()[0]?.ended).toBe(true)
		} finally {
			await store.close()
		}
	})

	it("describes the commit shape and size on the span", async () => {
		// A duration alone cannot tell a large history from a store that
		// stopped appending, which is the distinction worth seeing.
		const store = await openStore(createFixturePath())
		const parent = fakeSpan("caller", { name: "caller", attributes: {}, ended: false })

		try {
			await store.append({ ts: 10, value: "a" })
			await runInSpanScope(parent, () => store.flush())

			expect(flushSpans()[0]?.attributes).toMatchObject({ commit: "buffered_append", size: "<100" })
		} finally {
			await store.close()
		}
	})

	it("does not open a span for a commit with no caller to attribute it to", async () => {
		// This is the periodic-flush case. A root trace per interval per open
		// store would add traces without adding information.
		const store = await openStore(createFixturePath())

		try {
			await store.append({ ts: 10, value: "a" })
			await store.flush()

			expect(flushSpans()).toEqual([])
		} finally {
			await store.close()
		}
	})

	it("fails the span and reports the failure when the commit throws", async () => {
		// The periodic flush swallows its rejection, so without a failure
		// report a store that cannot write would look idle rather than broken.
		const store = await openStore(createFixturePath())
		const parent = fakeSpan("caller", { name: "caller", attributes: {}, ended: false })
		let failed = false

		try {
			await store.append({ ts: 10, value: "a" })
			// Replacing the backing insert is what makes the commit reject
			// without disturbing anything else about the store.
			const backing = (store as unknown as { store: { insert: unknown } }).store
			backing.insert = async () => {
				throw new Error("EACCES: permission denied")
			}

			await expect(runInSpanScope(parent, () => store.flush())).rejects.toThrow(/permission denied/)
			failed = true

			expect(flushSpans()[0]?.outcome).toBe("failure")
			expect(flushSpans()[0]?.ended).toBe(true)
		} finally {
			// A store whose writes fail cannot be closed cleanly; closing would
			// flush again and throw over the real assertion.
			if (!failed) await store.close()
		}
	})

	it("commits normally whether or not a span was opened", async () => {
		// The span must not become a condition for persistence.
		const filePath = createFixturePath()
		const store = await openStore(filePath)

		try {
			await store.append({ ts: 10, value: "a" })
			await store.flush()
			await store.append({ ts: 20, value: "b" })
			const parent = fakeSpan("caller", { name: "caller", attributes: {}, ended: false })
			await runInSpanScope(parent, () => store.flush())
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath)
		try {
			expect((await reopened.getAll()).map((row) => row.value)).toEqual(["a", "b"])
		} finally {
			await reopened.close()
		}
	})
})
