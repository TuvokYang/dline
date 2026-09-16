import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Behavior guard for the file-lock acquire measurement.
 *
 * This is the highest-frequency perf phase in the codebase, at roughly 17
 * samples a second, which makes it the place where an unbounded dimension
 * multiplies fastest. It is also the place where reporting only successful
 * acquires hid the worst samples: an acquire that exhausts its retries has
 * waited the longest and is the one that fails a write.
 */

const recorded = vi.hoisted(() => ({
	phases: [] as Array<{ domain: string; phase: string; durationMs: number; dimensions?: Record<string, unknown> }>,
}))

vi.mock("@/services/telemetry/instrumentation/duration-recorder", () => ({
	recordPerfPhase: (domain: string, phase: string, durationMs: number, dimensions?: Record<string, unknown>) => {
		recorded.phases.push({ domain, phase, durationMs, dimensions })
	},
	startPerfPhase: () => ({ stop: () => {}, active: false }),
	markPerfPhase: () => {},
}))

vi.mock("@/services/telemetry/instrumentation/diagnostic-recorder", () => ({
	recordDiagnostic: () => {},
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		log: () => {},
		trace: () => {},
		isDebugEnabled: () => false,
	},
}))

const { FileLock } = await import("../FileLock")

let workspace: string

beforeEach(async () => {
	recorded.phases.length = 0
	workspace = await mkdtemp(path.join(tmpdir(), "dline-filelock-"))
})

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true })
})

function acquires() {
	return recorded.phases.filter((entry) => entry.domain === "file_lock" && entry.phase === "acquire")
}

describe("file lock acquire observability", () => {
	it("reports an uncontended acquire", async () => {
		const lock = new FileLock()
		const target = path.join(workspace, "messages.jsonl")

		await lock.acquire(target)

		expect(acquires().map((entry) => entry.dimensions)).toEqual([{ outcome: "acquired", retried: false }])
		await lock.release(target)
	})

	it("reports an acquire that exhausted its retries", async () => {
		// Without this sample the distribution looks healthiest exactly when
		// contention is worst, because only the fast successes are recorded.
		const target = path.join(workspace, "held.jsonl")
		// A young lock owned by a live process is active, so the acquire below
		// retries to exhaustion instead of breaking it as stale.
		await writeFile(`${target}.lck`, JSON.stringify({ pid: process.pid, ownerId: "other-owner", ts: Date.now() }), "utf8")

		await expect(new FileLock().acquire(target)).rejects.toThrow(/Failed to acquire lock/)

		expect(acquires().map((entry) => entry.dimensions)).toEqual([{ outcome: "timeout", retried: true }])
		// The wait is the reason this sample matters, so it has to carry it.
		expect(acquires()[0]?.durationMs).toBeGreaterThan(0)
	})

	it("separates a filesystem fault from contention", async () => {
		// A missing directory is not a busy lock, and the two call for
		// different fixes, so they must not land in the same bucket.
		const target = path.join(workspace, "missing-dir", "orphan.jsonl")

		await expect(new FileLock().acquire(target)).rejects.toThrow()

		expect(acquires().map((entry) => entry.dimensions)).toEqual([{ outcome: "error", retried: false }])
	})

	it("keeps every reported dimension bounded", async () => {
		const lock = new FileLock()
		const target = path.join(workspace, "bounded.jsonl")

		await lock.acquire(target)
		await lock.release(target)

		const allowedOutcomes = new Set(["acquired", "timeout", "error"])
		for (const entry of acquires()) {
			expect(allowedOutcomes.has(String(entry.dimensions?.outcome))).toBe(true)
			expect(typeof entry.dimensions?.retried).toBe("boolean")
			// The lock file name is not bounded: profile-scoped locks embed a
			// profile identity in it, so reporting it would grow with the
			// number of profiles and leak that identity into metrics.
			expect(Object.keys(entry.dimensions ?? {}).sort()).toEqual(["outcome", "retried"])
		}
	})
})
