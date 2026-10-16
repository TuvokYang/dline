import type { CheckpointSource } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { CheckpointGate, type CheckpointGateObservation, type CheckpointGateState, type CheckpointRow } from "./CheckpointGate"

type Refs = string

/**
 * A task as the gate sees it: a journal of entries, a workspace that records
 * writes until they are committed, and the rows and bundles the gate wrote.
 */
function harness(options: { initialState?: () => CheckpointGateState<Refs> } = {}) {
    const journal: Array<"message" | "marker"> = []
    const workspace = { dirty: true, head: 0, commitError: undefined as Error | undefined, commits: 0 }
    const rows: Array<{ row: CheckpointRow; refs?: Refs; anchor?: CheckpointRow; source?: CheckpointSource }> = []
    const bundles: Array<{ row: CheckpointRow; refs?: Refs; anchor?: CheckpointRow }> = []
    const observations: CheckpointGateObservation[] = []
    const failures = {
        row: undefined as Error | undefined,
        bundle: undefined as Error | undefined,
        conversation: undefined as Error | undefined,
    }
    let nextTs = 100
    const hooks = { onRowWrite: undefined as (() => Promise<void>) | undefined }

    const gate = new CheckpointGate<Refs>({
        taskId: "task-1",
        workspace: {
            hasChanges: () => workspace.dirty,
            commit: async () => {
                workspace.commits += 1
                if (workspace.commitError) throw workspace.commitError
                workspace.dirty = false
                return `refs-${workspace.head}`
            },
            sameRefs: (left, right) => left === right,
        },
        conversation: {
            advancedSince: async (position) => {
                if (failures.conversation) throw failures.conversation
                return journal.slice(position).some((kind) => kind !== "marker")
            },
        },
        rows: {
            write: async (input) => {
                await hooks.onRowWrite?.()
                if (failures.row) throw failures.row
                const row: CheckpointRow = { ts: nextTs++, position: journal.length }
                rows.push({ row, ...input })
                return row
            },
            attach: async (row, refs) => {
                const entry = rows.find((candidate) => candidate.row.ts === row.ts)
                if (entry) entry.refs = refs
            },
        },
        bundles: {
            capture: async (input) => {
                if (failures.bundle) throw failures.bundle
                journal.push("marker")
                bundles.push(input)
            },
        },
        observe: (observation) => observations.push(observation),
        ...(options.initialState ? { initialState: options.initialState } : {}),
    })

    return {
        gate,
        journal,
        workspace,
        rows,
        bundles,
        observations,
        failures,
        hooks,
        say: () => journal.push("message"),
        write: () => {
            workspace.head += 1
            workspace.dirty = true
        },
    }
}

describe("CheckpointGate", () => {
    describe("round checks", () => {
        it("adds one row for a round and covers the same round when it is checked again", async () => {
            const subject = harness()
            subject.say()

            const source = { kind: "round_start" as const, turnId: "turn-1" }
            const first = await subject.gate.ensureRound("round_start", source)
            const second = await subject.gate.ensureRound("round_start", source)

            expect(first.outcome).toBe("created")
            expect(second.outcome).toBe("covered")
            expect(subject.rows).toHaveLength(1)
            expect(subject.rows[0]).toMatchObject({ row: { position: 1 }, source })
            expect(subject.rows[0].refs).toBeUndefined()
            expect(subject.bundles).toEqual([{ row: subject.rows[0].row, refs: "refs-0" }])
        })

        it("covers a pre-compaction check when the existing checkpoint restores the same state", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start", { kind: "round_start", turnId: "turn-1" })

            const result = await subject.gate.ensureRound("pre_compaction", { kind: "pre_compaction" })

            expect(result.outcome).toBe("covered")
            expect(subject.workspace.commits).toBe(1)
            expect(subject.rows.map((entry) => entry.source)).toEqual([{ kind: "round_start", turnId: "turn-1" }])
        })

        it("does not create an adjacent duplicate merely because the provider turn id changed", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start", { kind: "round_start", turnId: "turn-1" })

            const result = await subject.gate.ensureRound("round_start", { kind: "round_start", turnId: "turn-2" })

            expect(result.outcome).toBe("covered")
            expect(subject.rows).toHaveLength(1)
            subject.say()
            expect((await subject.gate.ensureRound("round_start", { kind: "round_start", turnId: "turn-2" })).outcome).toBe(
                "created",
            )
            expect(subject.rows.at(-1)?.source).toEqual({ kind: "round_start", turnId: "turn-2" })
        })

        it("keeps chat-only rows without a file restore baseline when no files changed", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.say()

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("created")
            expect(subject.workspace.commits).toBe(1)
            expect(subject.rows.map((entry) => entry.refs)).toEqual([undefined, undefined])
        })

        it("attaches the old baseline only after the next commit proves files changed", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.say()
            subject.write()

            await subject.gate.ensureRound("round_start")

            expect(subject.workspace.commits).toBe(2)
            expect(subject.rows.map((entry) => entry.refs)).toEqual(["refs-0", undefined])
            expect(subject.bundles.map((entry) => entry.refs)).toEqual(["refs-0", "refs-1"])
        })

        it("adds a row before compaction when only the files changed", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.write()

            const result = await subject.gate.ensureRound("pre_compaction")

            expect(result.outcome).toBe("created")
            expect(subject.rows.map((entry) => entry.refs)).toEqual(["refs-0", undefined])
        })

        it("covers a reported change whose commit restores the same files", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.workspace.dirty = true

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("covered")
            expect(subject.rows).toHaveLength(1)
        })

        it("treats a conversation it cannot read as moved on", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.failures.conversation = new Error("journal unavailable")

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("created")
        })
    })

    describe("failures stay inside the checkpoint", () => {
        it("keeps a row without files when the commit fails and the conversation moved on", async () => {
            const subject = harness()
            subject.say()
            subject.workspace.commitError = new Error("index.lock exists")

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("created")
            expect(subject.rows[0].refs).toBeUndefined()
            expect(subject.observations.at(-1)).toMatchObject({ reason: "round_start", outcome: "failed", part: "file" })
        })

        it("does not reuse earlier files after a failed commit, and commits again next round", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.say()
            subject.write()
            subject.workspace.commitError = new Error("index.lock exists")
            await subject.gate.ensureRound("round_start")
            subject.workspace.commitError = undefined
            subject.say()

            await subject.gate.ensureRound("round_start")

            expect(subject.rows.map((entry) => entry.refs)).toEqual([undefined, undefined, undefined])
            expect(subject.workspace.commits).toBe(3)
        })

        it("adds nothing when the commit fails and the conversation did not move", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.write()
            subject.workspace.commitError = new Error("disk full")

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("failed")
            expect(subject.rows).toHaveLength(1)
        })

        it("lets the task go on when the row cannot be written", async () => {
            const subject = harness()
            subject.say()
            subject.failures.row = new Error("messages.db is locked")

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("failed")
            expect(subject.bundles).toEqual([])
            expect(subject.observations.at(-1)).toMatchObject({ outcome: "failed", part: "row", errorName: "Error" })
        })

        it("keeps the row when its bundle cannot be captured", async () => {
            const subject = harness()
            subject.say()
            subject.failures.bundle = new Error("payload store unavailable")

            const result = await subject.gate.ensureRound("round_start")
            const again = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("created")
            expect(subject.rows).toHaveLength(1)
            expect(again.outcome).toBe("covered")
            expect(subject.observations[0]).toMatchObject({ outcome: "failed", part: "bundle" })
        })

        it("reports every check with its wait, hold and commit times", async () => {
            const subject = harness()
            subject.say()

            await subject.gate.ensureRound("round_start")

            expect(subject.observations).toEqual([
                expect.objectContaining({
                    reason: "round_start",
                    outcome: "created",
                    waitMs: expect.any(Number),
                    holdMs: expect.any(Number),
                    commitMs: expect.any(Number),
                }),
            ])
        })
    })

    describe("completion", () => {
        it("commits the post-state without a row and lets later rounds reuse it", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")
            subject.write()

            const refs = await subject.gate.commitFiles()
            subject.say()
            await subject.gate.ensureRound("round_start")

            expect(refs).toBe("refs-1")
            expect(subject.rows.map((entry) => entry.refs)).toEqual(["refs-0", undefined])
            expect(subject.workspace.commits).toBe(2)
        })
    })

    describe("lock", () => {
        it("serializes concurrent checks so one round adds one row", async () => {
            const subject = harness()
            subject.say()

            const results = await Promise.all([subject.gate.ensureRound("round_start"), subject.gate.ensureRound("round_start")])

            expect(results.map((result) => result.outcome)).toEqual(["created", "covered"])
            expect(subject.rows).toHaveLength(1)
        })

        it("skips a check made from inside a running one instead of waiting on itself", async () => {
            const subject = harness()
            subject.say()
            let nested: Promise<unknown> | undefined
            subject.hooks.onRowWrite = async () => {
                subject.hooks.onRowWrite = undefined
                nested = subject.gate.ensureRound("pre_compaction")
                await nested
            }

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("created")
            await expect(nested).resolves.toEqual({ outcome: "skipped" })
        })

        it("holds a workspace mutation behind work already admitted without adding another checkpoint", async () => {
            const subject = harness()
            subject.say()
            let release!: () => void
            subject.hooks.onRowWrite = () => new Promise<void>((resolve) => (release = resolve))
            const running = subject.gate.ensureRound("round_start")
            await vi.waitFor(() => expect(release).toBeDefined())

            let barrierSettled = false
            const barrier = subject.gate.waitForPendingWork().then(() => {
                barrierSettled = true
            })
            await Promise.resolve()

            expect(barrierSettled).toBe(false)
            expect(subject.rows).toHaveLength(0)
            release()
            await Promise.all([running, barrier])
            expect(subject.rows).toHaveLength(1)
        })

        it("releases the mutation barrier when admitted checkpoint work degrades", async () => {
            const subject = harness()
            subject.say()
            subject.workspace.commitError = new Error("shadow repository unavailable")
            const running = subject.gate.ensureRound("round_start")

            await expect(subject.gate.waitForPendingWork()).resolves.toBeUndefined()
            await expect(running).resolves.toMatchObject({ outcome: "created" })
        })

        it("holds the next round behind a started mutation so its file delta attaches to the preceding row", async () => {
            const subject = harness()
            subject.say()
            await subject.gate.ensureRound("round_start")

            const settleMutation = await subject.gate.beginMutation()
            subject.write()
            subject.say()
            let roundSettled = false
            const nextRound = subject.gate.ensureRound("round_start").then((result) => {
                roundSettled = true
                return result
            })
            await Promise.resolve()

            expect(roundSettled).toBe(false)
            expect(subject.rows).toHaveLength(1)
            settleMutation()
            await expect(nextRound).resolves.toMatchObject({ outcome: "created" })

            expect(subject.rows.map((entry) => entry.refs)).toEqual(["refs-0", undefined])
            expect(subject.bundles.map((entry) => entry.refs)).toEqual(["refs-0", "refs-1"])
        })

        it("lets a cancelled caller leave the queue without letting two holders run", async () => {
            const subject = harness()
            subject.say()
            let releaseFirst!: () => void
            let active = 0
            let maxActive = 0
            subject.hooks.onRowWrite = async () => {
                active += 1
                maxActive = Math.max(maxActive, active)
                if (!releaseFirst) await new Promise<void>((resolve) => (releaseFirst = resolve))
                active -= 1
            }
            const first = subject.gate.ensureRound("round_start")
            await vi.waitFor(() => expect(releaseFirst).toBeDefined())
            const cancelled = new AbortController()
            const waiting = subject.gate.ensureRound("pre_compaction", cancelled.signal)
            subject.say()
            const third = subject.gate.ensureRound("round_start")

            cancelled.abort()
            await expect(waiting).resolves.toEqual({ outcome: "skipped" })
            releaseFirst()
            await Promise.all([first, third])

            expect(maxActive).toBe(1)
            expect(subject.rows).toHaveLength(1)
        })

        it("waits for admitted work on close and refuses work after it", async () => {
            const subject = harness()
            subject.say()
            let release!: () => void
            subject.hooks.onRowWrite = () => new Promise<void>((resolve) => (release = resolve))
            const running = subject.gate.ensureRound("round_start")
            await vi.waitFor(() => expect(release).toBeDefined())

            let closed = false
            const closing = subject.gate.close().then(() => {
                closed = true
            })
            await Promise.resolve()
            expect(closed).toBe(false)
            release()
            await closing

            expect(subject.bundles).toHaveLength(1)
            await expect(running).resolves.toMatchObject({ outcome: "created" })
            await expect(subject.gate.ensureRound("round_start")).resolves.toEqual({ outcome: "skipped" })
        })
    })

    describe("reopened task", () => {
        it("reuses the restored checkpoint when only the producer kind changed", async () => {
            const subject = harness({
                initialState: () => ({
                    latestChat: { ts: 1, position: 1 },
                    latestSource: { kind: "round_start", turnId: "turn-1" },
                    latestRefs: "refs-0",
                }),
            })
            subject.say()
            subject.journal.push("marker")

            const result = await subject.gate.ensureRound("pre_compaction", { kind: "pre_compaction" })

            expect(result.outcome).toBe("covered")
            expect(subject.rows).toHaveLength(0)
        })

        it("continues from the latest checkpoint instead of adding a duplicate", async () => {
            const subject = harness({ initialState: () => ({ latestChat: { ts: 1, position: 1 }, latestRefs: "refs-0" }) })
            subject.say()
            subject.journal.push("marker")

            const result = await subject.gate.ensureRound("round_start")

            expect(result.outcome).toBe("covered")
            expect(subject.workspace.commits).toBe(1)
            expect(subject.rows).toHaveLength(0)
        })
    })
})
