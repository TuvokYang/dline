import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import type { BufferedUnifyStore } from "../../api/UnifyStore"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

vi.mock("@/services/telemetry/instrumentation/diagnostic-recorder", () => ({
	recordDiagnostic: vi.fn(),
}))

/**
 * Behavior guard for the timer-driven flush.
 *
 * The timer is faked so only the test decides when a tick runs; each tick is
 * driven through the same method the interval calls, against a stubbed flush,
 * because the policy under test is when to retry and what to log, not how a
 * commit is written.
 */

interface Row {
	ts: number
	value: string
}

interface PeriodicFlushProbe {
	runPeriodicFlush(): Promise<void>
}

const FLUSH_INTERVAL_MS = 1_000
const roots: string[] = []

function errnoError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: simulated`), { code })
}

async function openStore(): Promise<BufferedUnifyStore<Row>> {
	const root = mkdtempSync(path.join(os.tmpdir(), "dline-periodic-flush-"))
	roots.push(root)
	return openBufferedJsonlStore<Row>(path.join(root, "rows.jsonl"), {
		schemaId: "periodic-flush",
		flushIntervalMs: FLUSH_INTERVAL_MS,
	})
}

function tick(store: BufferedUnifyStore<Row>): Promise<void> {
	return (store as unknown as PeriodicFlushProbe).runPeriodicFlush()
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("BufferedUnifyStore periodic flush", () => {
	it("backs off after failures, logs only new failure codes, and resets after a success", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		let now = 1_000_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		const info = vi.spyOn(Logger, "info").mockImplementation(() => undefined)
		const store = await openStore()
		const flush = vi.spyOn(store, "flush").mockRejectedValue(errnoError("EPERM"))

		try {
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(1)
			expect(warn).toHaveBeenCalledTimes(1)
			expect(warn.mock.calls[0][0]).toContain("code=EPERM")

			// The first retry waits two intervals, so the next beat is skipped.
			now += FLUSH_INTERVAL_MS
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(1)

			now += FLUSH_INTERVAL_MS
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(2)
			expect(warn).toHaveBeenCalledTimes(1)

			// A different error code is new information and is logged again.
			flush.mockRejectedValue(errnoError("EBUSY"))
			now += 4 * FLUSH_INTERVAL_MS - 1
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(2)
			now += 1
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(3)
			expect(warn).toHaveBeenCalledTimes(2)
			expect(warn.mock.calls[1][0]).toContain("code=EBUSY")

			flush.mockResolvedValue(undefined)
			now += 8 * FLUSH_INTERVAL_MS
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(4)
			expect(info).toHaveBeenCalledWith(expect.stringContaining("periodic flush recovered"))

			// After a success the next beat runs without waiting.
			now += FLUSH_INTERVAL_MS
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(5)
		} finally {
			flush.mockRestore()
			await store.close()
		}
	})

	it("caps the backoff at thirty seconds", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		let now = 1_000_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		const store = await openStore()
		const flush = vi.spyOn(store, "flush").mockRejectedValue(errnoError("EPERM"))

		try {
			// Delays after failures 1..5 are 2s, 4s, 8s, 16s, then 30s instead of 32s.
			for (const delayMs of [0, 2_000, 4_000, 8_000, 16_000]) {
				now += delayMs
				await tick(store)
			}
			expect(flush).toHaveBeenCalledTimes(5)

			now += 30_000 - 1
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(5)
			now += 1
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(6)
		} finally {
			flush.mockRestore()
			await store.close()
		}
	})

	it("does not start a second periodic flush while one is still running", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		const store = await openStore()
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const flush = vi.spyOn(store, "flush").mockReturnValue(pending)

		try {
			const first = tick(store)
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(1)

			release()
			await first
			await tick(store)
			expect(flush).toHaveBeenCalledTimes(2)
		} finally {
			flush.mockRestore()
			await store.close()
		}
	})
})
