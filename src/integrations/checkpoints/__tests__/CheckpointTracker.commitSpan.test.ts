import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Behavior guard for the checkpoint commit span and its lock outcome.
 *
 * Users report checkpoint creation failing when many tasks run at once. The
 * cost is split between waiting for the shared shadow-repository lock and the
 * Git work itself, and until now neither the trace nor a metric separated the
 * two, so the report could not be confirmed from telemetry.
 *
 * The lock outcome is a bounded dimension. A lock identity or an error message
 * would be unbounded and must never reach a metric label.
 */

const recorded = vi.hoisted(() => ({
	spans: [] as Array<{
		name: string
		/** Name of the span this one hangs under, or undefined at the root. */
		parent?: string
		attributes?: Record<string, unknown>
		outcome?: string
		ended: boolean
		/** How many exceptions were recorded on this span. */
		exceptions: number
	}>,
	phases: [] as Array<{ domain: string; phase: string; dimensions?: Record<string, unknown> }>,
	/** Span names currently entered, innermost last. */
	scope: [] as string[],
}))

/** Drives how the shared checkpoint lock resolves for one call. */
const lock = vi.hoisted(() => ({
	result: { acquired: true, skipped: false } as { acquired: boolean; skipped: boolean; conflictingLock?: unknown },
	/** When set, the acquire helper rejects instead of resolving. */
	rejectWith: undefined as Error | undefined,
	/** Innermost span entered while the acquisition was running. */
	scopeDuringAcquire: undefined as string | undefined,
	released: 0,
}))

/** Drives whether the process mutex admits the caller. */
const mutex = vi.hoisted(() => ({
	rejectBeforeEntry: undefined as Error | undefined,
}))

vi.mock("../CheckpointMutexRegistry", () => ({
	CheckpointMutexRegistry: {
		getInstance: () => ({
			runExclusive: async <T>(_key: string, run: () => Promise<T>): Promise<T> => {
				// Rejecting without invoking `run` is the real shape of a wait
				// that never admitted the caller, which is the case the
				// attribution logic has to tell apart from a Git failure.
				if (mutex.rejectBeforeEntry) throw mutex.rejectBeforeEntry
				return run()
			},
		}),
	},
}))

vi.mock("@/services/telemetry/service/pipeline-port", () => ({
	startSignalSpan: (options: { name: string; attributes?: Record<string, unknown>; parent?: { name: string } }) => {
		const record = {
			name: options.name,
			parent: options.parent?.name,
			attributes: { ...options.attributes },
			outcome: undefined,
			ended: false,
			exceptions: 0,
		}
		recorded.spans.push(record as never)
		return {
			name: options.name,
			setAttribute: (key: string, value: unknown) => {
				;(record.attributes as Record<string, unknown>)[key] = value
			},
			end: (outcome?: string) => {
				record.outcome = outcome as never
				record.ended = true
			},
			recordException: () => {
				record.exceptions++
			},
		}
	},
	// Enters the span for the duration of the call, mirroring the real
	// async-local scope. Without this the tests could not tell whether the
	// production code correlated its work with the span or merely timed it.
	runWithSignalSpan: async <T>(span: { name: string }, run: () => T): Promise<T> => {
		recorded.scope.push(span.name)
		try {
			return await run()
		} finally {
			recorded.scope.pop()
		}
	},
}))

vi.mock("@/services/telemetry/instrumentation/duration-recorder", () => ({
	recordPerfPhase: (domain: string, phase: string, _durationMs: number, dimensions?: Record<string, unknown>) => {
		recorded.phases.push({ domain, phase, dimensions })
	},
	startPerfPhase: () => ({ stop: () => {}, active: false }),
	markPerfPhase: () => {},
}))

vi.mock("../CheckpointLockUtils", () => ({
	tryAcquireCheckpointLockWithRetry: async () => {
		// Captured here rather than asserted afterwards: the scope only exists
		// while the acquisition is in flight.
		lock.scopeDuringAcquire = recorded.scope[recorded.scope.length - 1]
		if (lock.rejectWith) throw lock.rejectWith
		return lock.result
	},
	releaseCheckpointLock: async () => {
		lock.released++
	},
}))

vi.mock("@/services/telemetry", () => ({ telemetryService: { captureCheckpointUsage: () => {} } }))

vi.mock("@core/controller/checkpoints/subscribeToCheckpoints", () => ({ sendCheckpointEvent: async () => {} }))

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

const { default: CheckpointTracker } = await import("../CheckpointTracker")

interface CommitCapableTracker {
	commitForFiles(files: string[]): Promise<string | undefined>
}

/** Reaches commitForFiles with the Git work stubbed to the branch under test. */
function createTracker(doCommitFiles: () => Promise<string | undefined>): CommitCapableTracker {
	const tracker = Object.create(CheckpointTracker.prototype)
	Object.assign(tracker, {
		taskId: "task-1",
		cwdHash: "hash-1",
		taskFileTracker: undefined,
		doCommitFiles,
		sendCheckpointSubscriptionEvent: async () => {},
	})
	return tracker as CommitCapableTracker
}

beforeEach(() => {
	recorded.spans.length = 0
	recorded.phases.length = 0
	recorded.scope.length = 0
	lock.result = { acquired: true, skipped: false }
	lock.rejectWith = undefined
	lock.scopeDuringAcquire = undefined
	lock.released = 0
	mutex.rejectBeforeEntry = undefined
})

/** The span the caller is executing inside, innermost first. */
function innermostScope(): string | undefined {
	return recorded.scope[recorded.scope.length - 1]
}

function spanNamed(name: string) {
	return recorded.spans.find((entry) => entry.name === name)
}

describe("checkpoint commit observability", () => {
	it("opens one span covering the lock wait and the commit", async () => {
		const tracker = createTracker(async () => "commit-hash")

		const hash = await tracker.commitForFiles(["src/a.ts"])

		expect(hash).toBe("commit-hash")
		const span = recorded.spans.find((entry) => entry.name === "checkpoint.commit")
		expect(span?.ended).toBe(true)
		expect(span?.outcome).toBe("success")
		expect(span?.attributes).toMatchObject({ explicit_files: true, lock_outcome: "acquired" })
	})

	it("reports the lock wait as its own bounded outcome", async () => {
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles([])

		const phase = recorded.phases.find((entry) => entry.phase === "commit_lock")
		expect(phase?.dimensions).toEqual({ outcome: "acquired", mechanism: "folder_lock" })
	})

	it("separates a skipped lock from an acquired one", async () => {
		lock.result = { acquired: false, skipped: true }
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		// A skipped lock means another mechanism serializes the work, which is a
		// different situation from holding the lock and must stay distinguishable.
		const outcomes = recorded.phases.filter((entry) => entry.phase === "commit_lock").map((entry) => entry.dimensions)
		expect(outcomes[0]).toEqual({ outcome: "skipped", mechanism: "folder_lock" })
	})

	it("reports a conflicted lock and fails the span", async () => {
		lock.result = { acquired: false, skipped: false, conflictingLock: { taskId: "other-task" } }
		const tracker = createTracker(async () => "commit-hash")

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		expect(recorded.phases.find((entry) => entry.phase === "commit_lock")?.dimensions).toEqual({
			outcome: "conflicted",
			mechanism: "folder_lock",
		})
		const span = recorded.spans.find((entry) => entry.name === "checkpoint.commit")
		expect(span?.outcome).toBe("failure")
		expect(span?.ended).toBe(true)
	})

	it("separates a lock that could not be consulted from a real conflict", async () => {
		// The lock layer also reports failure when it could not be read at all.
		// Calling that a conflict would send the reader looking for contention
		// that never happened.
		lock.result = { acquired: false, skipped: false }
		const tracker = createTracker(async () => "commit-hash")

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		expect(recorded.phases.find((entry) => entry.phase === "commit_lock")?.dimensions).toEqual({
			outcome: "failed",
			mechanism: "folder_lock",
		})
	})

	it("fails the span when no checkpoint was created", async () => {
		// Staging can legitimately produce no commit, and the caller treats a
		// missing hash as a failed checkpoint. Reporting success here would hide
		// the failure this span exists to find.
		const tracker = createTracker(async () => undefined)

		const hash = await tracker.commitForFiles(["src/a.ts"])

		expect(hash).toBeUndefined()
		const span = recorded.spans.find((entry) => entry.name === "checkpoint.commit")
		expect(span?.outcome).toBe("failure")
		expect(span?.attributes).toMatchObject({ created: false })
	})

	it("closes the span when the Git work itself fails", async () => {
		const tracker = createTracker(async () => {
			throw new Error("fatal: unable to write C:\\workspace\\.git\\index")
		})

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		const span = recorded.spans.find((entry) => entry.name === "checkpoint.commit")
		expect(span?.outcome).toBe("failure")
		// The lock was reached, so its outcome still has to be reported.
		expect(span?.attributes).toMatchObject({ lock_outcome: "acquired" })
	})

	it("splits the commit into a lock span and a Git span under one parent", async () => {
		// The split is the whole point: an attribute has no extent, so only
		// child spans can show a reader whether a slow commit was waiting for
		// the shared repository or doing the Git work.
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		expect(recorded.spans.map((entry) => entry.name)).toEqual([
			"checkpoint.commit",
			"checkpoint.commit_lock",
			"checkpoint.git",
		])
		expect(spanNamed("checkpoint.commit")?.parent).toBeUndefined()
		expect(spanNamed("checkpoint.commit_lock")?.parent).toBe("checkpoint.commit")
		expect(spanNamed("checkpoint.git")?.parent).toBe("checkpoint.commit")
		expect(recorded.spans.every((entry) => entry.ended)).toBe(true)
	})

	it("runs the Git work inside its own span", async () => {
		// Correlation, not just timing: logs emitted by the Git work have to
		// carry the Git span so a trace can show them against that step rather
		// than against the commit as a whole.
		let scopeDuringCommit: string | undefined
		const tracker = createTracker(async () => {
			scopeDuringCommit = innermostScope()
			return "commit-hash"
		})

		await tracker.commitForFiles(["src/a.ts"])

		expect(scopeDuringCommit).toBe("checkpoint.git")
		expect(recorded.scope).toEqual([])
	})

	it("closes the lock span before the Git work begins", async () => {
		// Overlapping spans would read as concurrent work on the waterfall and
		// make the wait look like part of the commit.
		let lockEndedFirst = false
		const tracker = createTracker(async () => {
			lockEndedFirst = spanNamed("checkpoint.commit_lock")?.ended === true
			return "commit-hash"
		})

		await tracker.commitForFiles(["src/a.ts"])

		expect(lockEndedFirst).toBe(true)
	})

	it("times the process mutex as the wait when the folder lock stands aside", async () => {
		// In VS Code the folder lock returns immediately and the mutex is what
		// actually serializes concurrent tasks, so reporting only the folder
		// lock would hide the wait users experience.
		lock.result = { acquired: false, skipped: true }
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		const mechanisms = recorded.phases
			.filter((entry) => entry.phase === "commit_lock")
			.map((entry) => entry.dimensions?.mechanism)
		expect(mechanisms).toEqual(["folder_lock", "process_mutex"])
		const mutexSpan = recorded.spans.find(
			(entry) => entry.name === "checkpoint.commit_lock" && entry.attributes?.mechanism === "process_mutex",
		)
		expect(mutexSpan?.parent).toBe("checkpoint.commit")
		expect(mutexSpan?.outcome).toBe("success")
	})

	it("reports Git work that produced no commit apart from one that did", async () => {
		// Both return normally, but only one leaves the caller a restore point.
		const tracker = createTracker(async () => undefined)

		await tracker.commitForFiles(["src/a.ts"])

		expect(recorded.phases.find((entry) => entry.phase === "commit")?.dimensions).toEqual({ outcome: "none" })
		expect(spanNamed("checkpoint.git")?.outcome).toBe("success")
	})

	it("marks the Git span failed and records the exception when it throws", async () => {
		const tracker = createTracker(async () => {
			throw new Error("fatal: unable to write C:\\workspace\\.git\\index")
		})

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		const gitSpan = spanNamed("checkpoint.git")
		expect(gitSpan?.outcome).toBe("failure")
		expect(gitSpan?.ended).toBe(true)
		expect(recorded.phases.find((entry) => entry.phase === "commit")?.dimensions).toEqual({ outcome: "error" })
		// The message carries an absolute path and must stay off the metric,
		// but the span should still carry the exception for diagnosis.
		expect(recorded.spans.every((entry) => entry.ended)).toBe(true)
	})

	it("blames the mutex when the wait never admitted the caller", async () => {
		lock.result = { acquired: false, skipped: true }
		mutex.rejectBeforeEntry = new Error("mutex disposed")
		const tracker = createTracker(async () => "commit-hash")

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		const mutexPhases = recorded.phases.filter(
			(entry) => entry.phase === "commit_lock" && entry.dimensions?.mechanism === "process_mutex",
		)
		expect(mutexPhases.map((entry) => entry.dimensions?.outcome)).toEqual(["failed"])
		const mutexSpan = recorded.spans.find(
			(entry) => entry.name === "checkpoint.commit_lock" && entry.attributes?.mechanism === "process_mutex",
		)
		expect(mutexSpan?.outcome).toBe("failure")
		expect(mutexSpan?.exceptions).toBe(1)
		// The Git work never ran, so it must not appear at all.
		expect(recorded.spans.some((entry) => entry.name === "checkpoint.git")).toBe(false)
	})

	it("does not blame the mutex for a failure that happened after it admitted the caller", async () => {
		// Once the callback is running the wait is over. Reporting a mutex
		// failure here would invent contention out of a Git fault.
		lock.result = { acquired: false, skipped: true }
		const tracker = createTracker(async () => {
			throw new Error("fatal: unable to write index")
		})

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		const mutexOutcomes = recorded.phases
			.filter((entry) => entry.phase === "commit_lock" && entry.dimensions?.mechanism === "process_mutex")
			.map((entry) => entry.dimensions?.outcome)
		expect(mutexOutcomes).toEqual(["acquired"])
		const mutexSpan = recorded.spans.find(
			(entry) => entry.name === "checkpoint.commit_lock" && entry.attributes?.mechanism === "process_mutex",
		)
		expect(mutexSpan?.outcome).toBe("success")
		expect(spanNamed("checkpoint.git")?.outcome).toBe("failure")
	})

	it("reports a lock that could not be consulted at all", async () => {
		// The helper resolves the checkpoint directory before consulting the
		// lock, and that resolution can reject. Leaving the span open here
		// would drop the failure from both the trace and the metric.
		lock.rejectWith = new Error("EACCES: permission denied, mkdir")
		const tracker = createTracker(async () => "commit-hash")

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		expect(recorded.phases.find((entry) => entry.phase === "commit_lock")?.dimensions).toEqual({
			outcome: "failed",
			mechanism: "folder_lock",
		})
		const lockSpan = spanNamed("checkpoint.commit_lock")
		expect(lockSpan?.ended).toBe(true)
		expect(lockSpan?.outcome).toBe("failure")
		expect(lockSpan?.exceptions).toBe(1)
		expect(recorded.spans.every((entry) => entry.ended)).toBe(true)
	})

	it("treats an empty commit hash as no checkpoint created", async () => {
		// simple-git can return an empty commit string, which leaves the caller
		// without a restore point just as an absent hash does.
		const tracker = createTracker(async () => "")

		const hash = await tracker.commitForFiles(["src/a.ts"])

		expect(hash).toBe("")
		expect(spanNamed("checkpoint.commit")?.attributes).toMatchObject({ created: false })
		expect(recorded.phases.find((entry) => entry.phase === "commit")?.dimensions).toEqual({ outcome: "none" })
	})

	it("records the exception on the root span when the commit fails", async () => {
		const tracker = createTracker(async () => {
			throw new Error("fatal: unable to write index")
		})

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		expect(spanNamed("checkpoint.commit")?.exceptions).toBe(1)
		expect(spanNamed("checkpoint.git")?.exceptions).toBe(1)
	})

	it("runs the lock acquisition inside its own span", async () => {
		// Correlation for the waiting half too. Logs emitted while waiting have
		// to carry the lock span, not the commit as a whole.
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		expect(lock.scopeDuringAcquire).toBe("checkpoint.commit_lock")
		expect(spanNamed("checkpoint.commit_lock")?.parent).toBe("checkpoint.commit")
	})

	it("keeps the Git phase dimensions bounded", async () => {
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		const allowed = new Set(["success", "none", "error"])
		for (const phase of recorded.phases.filter((entry) => entry.phase === "commit")) {
			expect(allowed.has(String(phase.dimensions?.outcome))).toBe(true)
			// A staged-file count or a path would grow without bound.
			expect(Object.keys(phase.dimensions ?? {})).toEqual(["outcome"])
		}
	})

	it("keeps every reported dimension bounded", async () => {
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		const allowedOutcomes = new Set(["acquired", "skipped", "conflicted", "failed"])
		const allowedMechanisms = new Set(["folder_lock", "process_mutex"])
		for (const phase of recorded.phases.filter((entry) => entry.phase === "commit_lock")) {
			expect(allowedOutcomes.has(String(phase.dimensions?.outcome))).toBe(true)
			expect(allowedMechanisms.has(String(phase.dimensions?.mechanism))).toBe(true)
			// A path or a lock identity would grow without bound across workspaces.
			expect(Object.keys(phase.dimensions ?? {}).sort()).toEqual(["mechanism", "outcome"])
		}
	})
})

describe("checkpoint commit attempt accounting", () => {
	// `checkpoint.commit` measures only the Git work, which runs after exclusive
	// access has been granted. An attempt refused the lock never reaches it, so
	// a ratio built on that metric stays empty exactly when every attempt is
	// failing — the case users report. These tests pin the attempt-level metric
	// that closes the gap.

	it("reports one attempt for a commit that created a restore point", async () => {
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		const attempts = recorded.phases.filter((entry) => entry.phase === "commit_attempt")
		expect(attempts).toHaveLength(1)
		expect(attempts[0]?.dimensions).toEqual({ outcome: "created" })
	})

	it("separates an attempt that produced nothing from one that created a commit", async () => {
		// An absent hash is not the benign "nothing changed" case: that path
		// reuses and returns the current shadow HEAD. It comes from staging
		// failures, so the caller is left with nothing to restore from.
		const tracker = createTracker(async () => undefined)

		await tracker.commitForFiles(["src/a.ts"])

		expect(recorded.phases.find((entry) => entry.phase === "commit_attempt")?.dimensions).toEqual({
			outcome: "no_restore_point",
		})
	})

	it("counts a conflicted folder lock as an attempt that never reached Git", async () => {
		lock.result = { acquired: false, skipped: false, conflictingLock: { taskId: "other-task" } }
		const tracker = createTracker(async () => "commit-hash")

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		// The Git phase is absent by design here; without the attempt metric the
		// refusal would be invisible to any ratio built on `checkpoint.commit`.
		expect(recorded.phases.some((entry) => entry.phase === "commit")).toBe(false)
		expect(recorded.phases.find((entry) => entry.phase === "commit_attempt")?.dimensions).toEqual({
			outcome: "lock_unavailable",
		})
	})

	it("counts a lock that could not be consulted as unavailable rather than an error", async () => {
		lock.rejectWith = new Error("checkpoint directory could not be created")
		const tracker = createTracker(async () => "commit-hash")

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		expect(recorded.phases.find((entry) => entry.phase === "commit_attempt")?.dimensions).toEqual({
			outcome: "lock_unavailable",
		})
	})

	it("counts a mutex that never admitted the caller as unavailable", async () => {
		lock.result = { acquired: false, skipped: true }
		mutex.rejectBeforeEntry = new Error("mutex rejected")
		const tracker = createTracker(async () => "commit-hash")

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		expect(recorded.phases.find((entry) => entry.phase === "commit_attempt")?.dimensions).toEqual({
			outcome: "lock_unavailable",
		})
	})

	it("blames the attempt on the Git work when the lock was obtained", async () => {
		// Attributing this to the lock would send the reader looking for
		// contention when the repository work is what failed.
		const tracker = createTracker(async () => {
			throw new Error("git failed")
		})

		await expect(tracker.commitForFiles(["src/a.ts"])).rejects.toThrow()

		expect(recorded.phases.find((entry) => entry.phase === "commit_attempt")?.dimensions).toEqual({
			outcome: "error",
		})
	})

	it("keeps the attempt dimensions bounded", async () => {
		const tracker = createTracker(async () => "commit-hash")

		await tracker.commitForFiles(["src/a.ts"])

		const allowed = new Set(["created", "no_restore_point", "lock_unavailable", "error"])
		for (const phase of recorded.phases.filter((entry) => entry.phase === "commit_attempt")) {
			expect(allowed.has(String(phase.dimensions?.outcome))).toBe(true)
			// A workspace path or task identity would grow without bound.
			expect(Object.keys(phase.dimensions ?? {})).toEqual(["outcome"])
		}
	})
})
