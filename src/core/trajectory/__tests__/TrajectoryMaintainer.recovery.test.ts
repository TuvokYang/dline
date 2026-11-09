import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { closeInstanceStoragesUnder, ensureInstanceLayout } from "../../storage/instance"
import { openUiMessageRows, UI_MESSAGE_WRITER } from "../../storage/messages/openUiMessageRows"
import { UI_MESSAGE_COMMIT_RETENTION, type UiMessageRowStore } from "../../storage/messages/UiMessageRowStore"
import type { UiMessageRecord } from "../../storage/messages/UiMessageRows"
import { openTrajectoryRows } from "../../storage/trajectory/openTrajectoryRows"
import {
    stampOf,
    type TrajectoryMeta,
    type TrajectoryRowStore,
    type TrajectoryWriteResult,
} from "../../storage/trajectory/TrajectoryRowStore"
import { UIMessage } from "../../storage/UIMessage"
import type { CommittedUiMessages } from "../CommittedUiMessages"
import { closeOpenTurn, EMPTY_FOLD_CARRY, foldTrajectory } from "../foldTrajectory"
import {
    type MaintainerClock,
    TRAJECTORY_BUILDER_VERSION,
    TRAJECTORY_SLICE_ROWS,
    TrajectoryMaintainer,
    type TrajectoryStore,
} from "../TrajectoryMaintainer"

const TASK_ID = "task-recovering"
const WRITABLE = { writable: () => true }
const TS_START = 1_000
const TS_STEP = 10
/** The no-progress window after which a building job of another maintainer is taken over. */
const TAKEOVER_WINDOW_MS = 5_000
const TOOL_TEXT = JSON.stringify({ tool: "readFile", path: "a.ts" })

type RowKind = "task" | "user" | "tool"

function row(kind: RowKind, ts: number): UiMessage {
    if (kind === "tool") return { ts, type: "say", say: "tool", text: TOOL_TEXT } as UiMessage
    return { ts, type: "say", say: kind === "task" ? "task" : "user_feedback", text: `prompt ${ts}` } as UiMessage
}

/** `length` rows spaced by TS_STEP: the task prompt at 0, user prompts at `anchors`, tool rows elsewhere. */
function conversation(length: number, anchors: readonly number[] = []): UiMessage[] {
    const prompts = new Set(anchors)
    return Array.from({ length }, (_, ordinal) =>
        row(ordinal === 0 ? "task" : prompts.has(ordinal) ? "user" : "tool", TS_START + ordinal * TS_STEP),
    )
}

/** `rows` with the row at `ordinal` turned into a user prompt that keeps its ts. */
function promote(rows: readonly UiMessage[], ordinal: number): UiMessage[] {
    const copy = [...rows]
    copy[ordinal] = row("user", rows[ordinal].ts)
    return copy
}

function records(messages: readonly UiMessage[]): UiMessageRecord[] {
    return messages.map((entry, ordinal) => ({ ordinal, ts: entry.ts, message: entry }))
}

function fullFold(messages: readonly UiMessage[]) {
    const fold = foldTrajectory(
        messages.map((entry, ordinal) => ({ ordinal, message: entry })),
        EMPTY_FOLD_CARRY,
    )
    const closing = closeOpenTurn(fold.carry)
    return closing ? [...fold.turns, closing] : fold.turns
}

interface Probe {
    /** Start ordinal of every row range read, in order. */
    readonly starts: number[]
    readonly ranges: [number, number][]
    /** Awaited before or after each durable row range read. */
    beforeRead?: () => Promise<unknown>
    afterRead?: () => Promise<unknown>
}

function newProbe(): Probe {
    return { starts: [], ranges: [] }
}

function probed(reader: CommittedUiMessages, probe: Probe): CommittedUiMessages {
    return {
        ...reader,
        rows: {
            readRange: async (start, end) => {
                probe.starts.push(start)
                probe.ranges.push([start, end])
                await probe.beforeRead?.()
                const rows = await reader.rows.readRange(start, end)
                await probe.afterRead?.()
                return rows
            },
        },
    }
}

/** Runs `action` before the `nth` read after installation (1-based) and lets the others pass. */
function onRead(nth: number, action: () => Promise<unknown>): () => Promise<unknown> {
    let calls = 0
    return async () => {
        calls++
        if (calls === nth) await action()
    }
}

/** Opens of every gate created by the running test, so a failed test cannot leave a run blocked. */
const pendingGates: (() => void)[] = []

function gate(): { readonly opened: Promise<void>; open(): void } {
    let release: () => void = () => undefined
    const opened = new Promise<void>((resolve) => {
        release = resolve
    })
    pendingGates.push(() => release())
    return { opened, open: () => release() }
}

/** The first `parties` callers wait for each other; later callers pass through. */
function rendezvous(parties: number): () => Promise<void> {
    let arrived = 0
    const all = gate()
    return () => {
        if (arrived >= parties) return Promise.resolve()
        arrived++
        if (arrived === parties) all.open()
        return all.opened
    }
}

/** A clock whose sleeps advance its time instantly and yield one macrotask. */
function fakeClock(): { readonly clock: MaintainerClock; readonly sleeps: number[] } {
    let now = 0
    const sleeps: number[] = []
    return {
        sleeps,
        clock: {
            now: () => now,
            sleep: async (ms) => {
                sleeps.push(ms)
                now += ms
                await new Promise<void>((resolve) => setImmediate(resolve))
            },
        },
    }
}

async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 5_000; attempt++) {
        if (condition()) return
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    throw new Error("Condition was not reached")
}

type WriteKind = "replaceFrom" | "updateMeta" | "clear"

interface Write {
    readonly kind: WriteKind
    readonly result: TrajectoryWriteResult
}

function recording(store: TrajectoryRowStore, writes: Write[], beforeReadMeta?: () => Promise<void>): TrajectoryStore {
    const record = async (kind: WriteKind, pending: Promise<TrajectoryWriteResult>) => {
        const result = await pending
        writes.push({ kind, result })
        return result
    }
    return {
        readMeta: async () => {
            await beforeReadMeta?.()
            return store.readMeta()
        },
        readSnapshot: (sinceRevision) => store.readSnapshot(sinceRevision),
        readTurn: (seq) => store.readTurn(seq),
        findTurnContaining: (ordinal) => store.findTurnContaining(ordinal),
        replaceFrom: (...args) => record("replaceFrom", store.replaceFrom(...args)),
        updateMeta: (...args) => record("updateMeta", store.updateMeta(...args)),
        clear: (...args) => record("clear", store.clear(...args)),
        // Every maintainer of a test shares one handle, as each window holds one; the test closes it.
        close: async () => undefined,
    }
}

function applied(writes: readonly Write[]): TrajectoryMeta[] {
    return writes.flatMap(({ result }) => (result.applied ? [result.meta] : []))
}

/**
 * Every write increments the revision it compared against, so a gap-free sequence
 * of applied revisions means no two writers ever won the same stamp.
 */
function expectSerializedWrites(writes: readonly Write[]): void {
    const metas = applied(writes).sort((a, b) => a.revision - b.revision)
    metas.forEach((meta, index) => {
        if (index === 0) return
        const previous = metas[index - 1]
        expect(meta.state).not.toBe("error")
        expect(meta.errorTs).toBeNull()
        expect(meta.revision).toBe(previous.revision + 1)
        if (meta.buildId === previous.buildId && meta.logId === previous.logId) {
            expect(meta.appliedCommitSeq).toBeGreaterThanOrEqual(previous.appliedCommitSeq)
        }
    })
}

describe("TrajectoryMaintainer recovery", () => {
    let documentsRoot: string
    let root: string
    let writer: UiMessageRowStore
    let reader: CommittedUiMessages
    let inspect: TrajectoryRowStore
    let maintainers: TrajectoryMaintainer[]

    interface SubjectOptions {
        readonly probe?: Probe
        readonly clock?: MaintainerClock
        readonly writes?: Write[]
        readonly beforeReadMeta?: () => Promise<void>
        readonly messages?: CommittedUiMessages
        readonly store?: TrajectoryStore
    }

    async function subject(options: SubjectOptions = {}): Promise<TrajectoryMaintainer> {
        // One process may hold only one writer of trajectory.db, so maintainers standing in for
        // separate windows share the handle; every write is still its own compare-and-set transaction.
        const store = options.store ?? recording(inspect, options.writes ?? [], options.beforeReadMeta)
        const created = new TrajectoryMaintainer({
            instanceId: TASK_ID,
            messages: options.messages ?? (options.probe ? probed(reader, options.probe) : reader),
            openStore: async () => store,
            clock: options.clock ?? fakeClock().clock,
        })
        maintainers.push(created)
        return created
    }

    async function expectHealed(rows: readonly UiMessage[], anchors: readonly number[]): Promise<void> {
        const { meta, turns } = await inspect.readSnapshot(-1)
        expect(meta).toMatchObject({
            state: "ready",
            job: null,
            errorTs: null,
            turnCount: turns.length,
            appliedCommitSeq: (await reader.log.head()).headSeq,
        })
        // These fixtures consist only of prompts and readFile rows. Expected
        // interval lengths/counts are specified independently of the fold.
        expect(
            turns.map(({ seq, anchorOrdinal, attemptSeq, rounds, toolUsage, endsAttempt }) => ({
                seq,
                anchorOrdinal,
                attemptSeq,
                rounds,
                toolUsage,
                endsAttempt,
            })),
        ).toEqual(
            anchors.map((anchorOrdinal, seq) => {
                const count = (anchors[seq + 1] ?? rows.length) - anchorOrdinal - 1
                return {
                    seq,
                    anchorOrdinal,
                    attemptSeq: 0,
                    rounds: 0,
                    toolUsage: count === 0 ? [] : [{ tool: "readFile", count }],
                    endsAttempt: false,
                }
            }),
        )
        expect(turns.map(({ revision: _revision, ...turn }) => turn)).toEqual(fullFold(rows))
    }

    beforeEach(async () => {
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-recovery-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        root = (await ensureInstanceLayout({ taskId: TASK_ID })).root
        writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
        reader = await UIMessage.openCommittedUiMessages(TASK_ID)
        inspect = await openTrajectoryRows(root)
        maintainers = []
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        for (const open of pendingGates.splice(0)) open()
        for (const maintainer of maintainers) await maintainer.close()
        await inspect.close().catch(() => undefined)
        await reader.close().catch(() => undefined)
        await writer.close().catch(() => undefined)
        await closeInstanceStoragesUnder(documentsRoot)
        vi.unstubAllEnvs()
        await rm(documentsRoot, { recursive: true, force: true })
    })

    describe("reads that overlap later commits", () => {
        it("heals a truncation committed between the head read and the row reads", async () => {
            await writer.replaceAll(records(conversation(8, [3, 6])))
            const probe = newProbe()
            const maintainer = await subject({ probe })
            await maintainer.catchUp(WRITABLE)

            const grown = conversation(10, [3, 6, 9])
            await writer.insert(records(grown).slice(8))
            const truncated = grown.slice(0, 5)
            probe.beforeRead = onRead(1, () => writer.replaceAll(records(truncated), { firstChangedIndex: 5 }))

            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            await expectHealed(truncated, [0, 3])
        })

        it("heals edits before and after the read cursor of a sliced build", async () => {
            const rows = conversation(1_100, [300, 700, 900])
            await writer.replaceAll(records(rows))
            const edited = promote(promote(rows, 100), 800)
            const probe = newProbe()
            probe.beforeRead = onRead(2, () => writer.replaceAll(records(edited), { firstChangedIndex: 100 }))
            const maintainer = await subject({ probe })

            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            await expectHealed(edited, [0, 100, 300, 700, 800, 900])
        })

        it("heals a same-ts edit that keeps the row count and every ts", async () => {
            await writer.replaceAll(records(conversation(6, [3])))
            const probe = newProbe()
            const maintainer = await subject({ probe })
            await maintainer.catchUp(WRITABLE)

            const grown = conversation(7, [3])
            await writer.insert(records(grown).slice(6))
            const edited = promote(grown, 1)
            expect(edited.map((entry) => entry.ts)).toEqual(grown.map((entry) => entry.ts))
            probe.beforeRead = onRead(1, () => writer.replaceAll(records(edited), { firstChangedIndex: 1 }))

            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            await expectHealed(edited, [0, 1, 3])
        })

        it.each(["equal", "reversed"])("repositions an insertion crossing row 499 using commits with %s ts", async (order) => {
            const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
            const rows = conversation(600, [200]).map((entry, ordinal) => ({
                ...entry,
                ts: order === "equal" ? 40 : 900 - ordinal,
            }))
            await writer.replaceAll(records(rows))
            const shifted = [...rows.slice(0, 10), row("tool", rows[9].ts), ...rows.slice(10)]
            const probe = newProbe()
            probe.beforeRead = onRead(2, () => writer.replaceAll(records(shifted), { firstChangedIndex: 10 }))
            const writes: Write[] = []
            const maintainer = await subject({ probe, writes })

            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

            // The insertion moved an already-read row across 500. Only the
            // commit watermark/change position, not any identity comparison,
            // can reveal the overlap when every ts is equal.
            expect(probe.starts.filter((start) => start === 0).length).toBeGreaterThanOrEqual(2)
            expect(probe.ranges.every(([start, end]) => end - start <= TRAJECTORY_SLICE_ROWS)).toBe(true)
            expect(applied(writes).some((meta) => meta.state === "error")).toBe(false)
            expect(warn.mock.calls.filter(([message]) => String(message).startsWith("[trajectory]"))).toEqual([])
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            await expectHealed(shifted, [0, 201])
        })
    })

    describe("committed positions during scans", () => {
        it.each([
            [100, 1, "before"],
            [800, 1, "after"],
            [500, 1, "after"],
            [700, 2, "before"],
        ] as const)("converges after a commit at %i around read %i (%s)", async (ordinal, nth, timing) => {
            const rows = conversation(1_100, [300, 700]).map((entry) => ({ ...entry, ts: 40 }))
            await writer.replaceAll(records(rows))
            const inserted = [...rows.slice(0, ordinal), row("user", 40), ...rows.slice(ordinal)]
            const probe = newProbe()
            const commit = onRead(nth, () => writer.replaceAll(records(inserted), { firstChangedIndex: ordinal }))
            if (timing === "before") probe.beforeRead = commit
            else probe.afterRead = commit
            const maintainer = await subject({ probe })
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            const expectedAnchors = {
                100: [0, 100, 301, 701],
                500: [0, 300, 500, 701],
                700: [0, 300, 700, 701],
                800: [0, 300, 700, 800],
            }
            const anchors = expectedAnchors[ordinal]
            await expectHealed(inserted, anchors)
            expect(probe.ranges.every(([start, end]) => end - start === TRAJECTORY_SLICE_ROWS)).toBe(true)
        })

        it("uses the retained-log floor conservatively instead of missing a trimmed edit", async () => {
            const rows = conversation(12, [4, 8]).map((entry) => ({ ...entry, ts: 40 }))
            await writer.replaceAll(records(rows))
            const probe = newProbe()
            const maintainer = await subject({ probe })
            await maintainer.catchUp(WRITABLE)
            const appliedSeq = (await reader.log.head()).headSeq
            const edited = promote(rows, 2)
            await writer.replaceAll(records(edited), { firstChangedIndex: 2 })
            for (let commit = 0; commit <= UI_MESSAGE_COMMIT_RETENTION; commit++) {
                expect(
                    await writer.replaceTail({
                        durableCount: edited.length,
                        expectedTailTimestamps: [40],
                        replacedCount: 1,
                        entries: [edited[edited.length - 1]],
                    }),
                ).toBe(true)
            }
            // Retention may include an even earlier floor position (ordinal 0).
            // C3 already incorporates it; the maintainer must not inspect diagnosis.
            const since = await reader.log.since(appliedSeq)
            expect(since.headSeq).toBeGreaterThan(appliedSeq + UI_MESSAGE_COMMIT_RETENTION)
            expect(since.minFirstChangedOrdinal).toBe(0)
            const readsBefore = probe.starts.length
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            expect(probe.starts.slice(readsBefore)[0]).toBe(0)
            await expectHealed(edited, [0, 2, 4, 8])
        }, 120_000)
    })

    it("rebuilds an in-flight job when the committed log identity changes between slices", async () => {
        const rows = conversation(700, [300, 600]).map((entry) => ({ ...entry, ts: 40 }))
        await writer.replaceAll(records(rows))
        const replacement = promote(rows, 100)
        let logId = (await reader.log.head()).logId
        const probe = newProbe()
        probe.afterRead = onRead(1, async () => {
            await writer.replaceAll(records(replacement), { firstChangedIndex: 100 })
            logId = "replacement-log"
        })
        const messages: CommittedUiMessages = {
            ...probed(reader, probe),
            log: {
                head: async () => ({ logId, headSeq: (await reader.log.head()).headSeq }),
                since: async (seq) => {
                    const { headSeq, minFirstChangedOrdinal } = await reader.log.since(seq)
                    return { logId, headSeq, minFirstChangedOrdinal }
                },
            },
        }
        const writes: Write[] = []
        const maintainer = await subject({ messages, writes })
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
        expect(writes.filter(({ kind }) => kind === "clear")).toHaveLength(2)
        expect((await inspect.readMeta())?.logId).toBe("replacement-log")
        await expectHealed(replacement, [0, 100, 300, 600])
    })

    describe("compare-and-set", () => {
        it("does not clear a newer valid job when another maintainer holds an older head", async () => {
            const base = conversation(620, [100])
            await writer.replaceAll(records(base))
            await (await subject()).catchUp(WRITABLE)
            const initial = await inspect.readSnapshot(-1)
            const initialHead = await reader.log.head()
            const captured = gate()
            const returnHead = gate()
            let firstHead = true
            const messages: CommittedUiMessages = {
                ...reader,
                log: {
                    since: (seq) => reader.log.since(seq),
                    head: async () => {
                        const head = await reader.log.head()
                        if (firstHead) {
                            firstHead = false
                            captured.open()
                            await returnHead.opened
                        }
                        return head
                    },
                },
            }
            const staleWrites: Write[] = []
            const stale = await subject({ messages, writes: staleWrites })
            const staleRun = stale.catchUp(WRITABLE)
            await captured.opened

            const grown = conversation(621, [100])
            await writer.insert(records(grown).slice(base.length))
            const jobWritten = gate()
            const resumeJob = gate()
            const probe = newProbe()
            probe.beforeRead = onRead(2, async () => {
                jobWritten.open()
                await resumeJob.opened
            })
            const winner = await subject({ probe })
            const winnerRun = winner.catchUp(WRITABLE)
            await jobWritten.opened
            const inFlight = await inspect.readMeta()
            expect(inFlight?.job?.targetSeq).toBe(initialHead.headSeq + 1)

            // The old observation is valid, but cannot justify clearing a newer cache epoch/job.
            returnHead.open()
            expect(await staleRun).toBe("ready")
            expect(staleWrites.filter(({ kind }) => kind === "clear")).toEqual([])
            expect(await inspect.readMeta()).toEqual(inFlight)
            resumeJob.open()
            expect(await winnerRun).toBe("ready")
            const settled = await inspect.readSnapshot(-1)
            expect(settled.meta?.buildId).toBe(initial.meta?.buildId)
            expect(settled.turns[0]).toEqual(initial.turns[0])
            await expectHealed(grown, [0, 100])
        })

        it("keeps revisions gap-free and applied commits monotonic across two interleaved maintainers", async () => {
            await writer.replaceAll(records(conversation(1_100, [300, 700])))
            const writes: Write[] = []
            const firstProbe = newProbe()
            const secondProbe = newProbe()
            const first = await subject({ probe: firstProbe, writes })
            const second = await subject({ probe: secondProbe, writes })

            const runs = Promise.all([first.catchUp(WRITABLE), second.catchUp(WRITABLE)])
            await until(() => firstProbe.starts.length + secondProbe.starts.length >= 2)
            const grown = conversation(1_103, [300, 700, 1_101])
            await writer.insert(records(grown).slice(1_100))

            expect(await runs).toEqual(["ready", "ready"])
            expect(await Promise.all([first.catchUp(WRITABLE), second.catchUp(WRITABLE)])).toEqual(["ready", "ready"])
            expectSerializedWrites(writes)
            await expectHealed(grown, [0, 300, 700, 1_101])
        })

        it("rejects a stale job whose stamp matches a later rebuild in everything but revision and buildId", async () => {
            const rows = conversation(1_100, [300, 700])
            await writer.replaceAll(records(rows))
            const writes: Write[] = []
            const firstPaused = gate()
            const secondPaused = gate()
            const firstProbe = newProbe()
            firstProbe.beforeRead = onRead(2, () => firstPaused.opened)
            const secondProbe = newProbe()
            secondProbe.beforeRead = onRead(2, () => secondPaused.opened)
            const first = await subject({ probe: firstProbe, writes })
            const second = await subject({ probe: secondProbe, writes })

            const firstRun = first.catchUp(WRITABLE)
            await until(() => firstProbe.starts.length === 2)
            const stale = (await inspect.readMeta()) as TrajectoryMeta
            expect(stale.job?.nextOrdinal).toBe(TRAJECTORY_SLICE_ROWS)

            // Another window rebuilds the cache and folds it to the same cursor.
            const request = { logId: stale.logId, builderVersion: TRAJECTORY_BUILDER_VERSION }
            writes.push({ kind: "clear", result: await inspect.clear(request, stampOf(stale)) })
            const secondRun = second.catchUp(WRITABLE)
            await until(() => secondProbe.starts.length === 2)
            const rebuilt = (await inspect.readMeta()) as TrajectoryMeta
            expect(rebuilt).toMatchObject({ state: stale.state, appliedCommitSeq: stale.appliedCommitSeq, job: stale.job })
            expect(rebuilt.buildId).not.toBe(stale.buildId)

            // Clear, metadata and suffix replacement all compare the same stamp.
            expect((await inspect.clear(request, stampOf(stale))).applied).toBe(false)
            const update = { state: "ready", appliedCommitSeq: stale.appliedCommitSeq, job: null, errorTs: null } as const
            expect((await inspect.updateMeta(update, stampOf(stale))).applied).toBe(false)
            expect((await inspect.replaceFrom(0, [], update, stampOf(stale))).applied).toBe(false)

            firstPaused.open()
            secondPaused.open()
            expect(await firstRun).toBe("ready")
            expect(await secondRun).toBe("ready")
            expect(writes.some(({ result }) => !result.applied)).toBe(true)
            expectSerializedWrites(writes)
            await expectHealed(rows, [0, 300, 700])
        })
    })

    describe("liveness without message commits", () => {
        it("brings two ownerless maintainers to ready after one loses the first compare-and-set", async () => {
            const rows = conversation(6, [3])
            await writer.replaceAll(records(rows))
            const writes: Write[] = []
            // Both read the missing meta before either clears it, so one clear must lose.
            const bothRead = rendezvous(2)
            const clocks = [fakeClock(), fakeClock()]
            const maintainers = await Promise.all(clocks.map(({ clock }) => subject({ clock, writes, beforeReadMeta: bothRead })))

            expect(await Promise.all(maintainers.map((maintainer) => maintainer.catchUp(WRITABLE)))).toEqual(["ready", "ready"])
            expect(writes.filter(({ kind, result }) => kind === "clear" && !result.applied)).toHaveLength(1)
            expect(clocks.some(({ sleeps }) => sleeps.length > 0)).toBe(true)
            expectSerializedWrites(writes)
            await expectHealed(rows, [0, 3])
        })

        it("takes over a job whose winner stopped advancing, and the resumed winner loses its next write", async () => {
            const rows = conversation(1_100, [300, 700])
            await writer.replaceAll(records(rows))
            const stalled = gate()
            const winnerProbe = newProbe()
            winnerProbe.beforeRead = onRead(2, () => stalled.opened)
            const winnerWrites: Write[] = []
            const winner = await subject({ probe: winnerProbe, writes: winnerWrites })
            const winnerRun = winner.catchUp(WRITABLE)
            await until(() => winnerProbe.starts.length === 2)

            const { clock, sleeps } = fakeClock()
            const otherProbe = newProbe()
            const other = await subject({ probe: otherProbe, clock })
            expect(await other.catchUp(WRITABLE)).toBe("ready")

            // It waited out the no-progress window, then resumed from the persisted cursor.
            expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(TAKEOVER_WINDOW_MS)
            expect(otherProbe.starts[0]).toBe(TRAJECTORY_SLICE_ROWS)
            await expectHealed(rows, [0, 300, 700])
            const finished = await inspect.readSnapshot(-1)

            stalled.open()
            expect(await winnerRun).toBe("ready")
            expect(winnerWrites.filter(({ result }) => !result.applied)).toHaveLength(1)
            expect(await inspect.readSnapshot(-1)).toEqual(finished)
        })
    })

    describe("rebuild", () => {
        const rows = conversation(700, [300, 600]).map((entry) => ({ ...entry, ts: 40 }))

        type Tamper = (meta: TrajectoryMeta, headSeq: number) => Promise<unknown>
        const ready = (headSeq: number) => ({ state: "ready", appliedCommitSeq: headSeq, job: null, errorTs: null }) as const

        const invalidCaches: [string, Tamper | undefined][] = [
            ["meta is missing", undefined],
            [
                "the builder version differs",
                async (meta, headSeq) => {
                    const cleared = await inspect.clear(
                        { logId: meta.logId, builderVersion: TRAJECTORY_BUILDER_VERSION + 1 },
                        stampOf(meta),
                    )
                    await inspect.updateMeta(ready(headSeq), stampOf(cleared.meta as TrajectoryMeta))
                },
            ],
            [
                "the log id differs",
                async (meta, headSeq) => {
                    const cleared = await inspect.clear(
                        { logId: "another-log", builderVersion: TRAJECTORY_BUILDER_VERSION },
                        stampOf(meta),
                    )
                    await inspect.updateMeta(ready(headSeq), stampOf(cleared.meta as TrajectoryMeta))
                },
            ],
            ["the applied commit is after the head", (meta, headSeq) => inspect.updateMeta(ready(headSeq + 5), stampOf(meta))],
            [
                "builder 3 has filtered ready turns at the current head",
                async (meta, headSeq) => {
                    const cleared = await inspect.clear({ logId: meta.logId, builderVersion: 3 }, stampOf(meta))
                    const old = fullFold(rows)
                        .filter((turn) => turn.seq !== 1)
                        .map((turn, seq) => ({ ...turn, seq }))
                    await inspect.replaceFrom(0, old, ready(headSeq), stampOf(cleared.meta as TrajectoryMeta))
                },
            ],
            [
                "builder 3 has an obsolete interrupted carry",
                async (meta, headSeq) => {
                    const cleared = await inspect.clear({ logId: meta.logId, builderVersion: 3 }, stampOf(meta))
                    await inspect.updateMeta(
                        {
                            state: "building",
                            appliedCommitSeq: 0,
                            errorTs: null,
                            job: { fromSeq: 0, nextOrdinal: 500, targetSeq: headSeq, carry: { obsolete: true, lastTs: 999 } },
                        },
                        stampOf(cleared.meta as TrajectoryMeta),
                    )
                },
            ],
            [
                "a legacy error is already at the current head",
                (meta, headSeq) => inspect.updateMeta({ ...ready(headSeq), state: "error", errorTs: 40 }, stampOf(meta)),
            ],
            [
                "a legacy error also has an obsolete job",
                (meta, headSeq) =>
                    inspect.updateMeta(
                        {
                            ...ready(headSeq),
                            state: "error",
                            errorTs: 40,
                            job: { fromSeq: 1, nextOrdinal: 500, targetSeq: headSeq, carry: { obsolete: true } },
                        },
                        stampOf(meta),
                    ),
            ],
            [
                "a job cursor targets a head that was replaced",
                (meta, headSeq) =>
                    inspect.updateMeta(
                        {
                            state: "building",
                            appliedCommitSeq: meta.appliedCommitSeq,
                            errorTs: null,
                            job: { fromSeq: 0, nextOrdinal: 500, targetSeq: headSeq + 5, carry: { obsolete: true } },
                        },
                        stampOf(meta),
                    ),
            ],
        ]

        it.each(invalidCaches)("rebuilds exactly once under a new buildId when %s", async (_case, tamper) => {
            await writer.replaceAll(records(rows))
            if (tamper) {
                const builder = await subject()
                await builder.catchUp(WRITABLE)
                await tamper((await inspect.readMeta()) as TrajectoryMeta, (await reader.log.head()).headSeq)
            }
            const before = await inspect.readMeta()
            const messagesBefore = await reader.rows.readRange(0, rows.length + 1)
            const headBefore = await reader.log.head()
            const commitsBefore = await reader.log.since(0)
            const probe = newProbe()
            const writes: Write[] = []
            const maintainer = await subject({ probe, writes })

            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

            expect(writes.filter(({ kind }) => kind === "clear")).toHaveLength(1)
            expect(probe.starts).toEqual([0, TRAJECTORY_SLICE_ROWS])
            expect((await inspect.readMeta())?.buildId).not.toBe(before?.buildId)
            await expectHealed(rows, [0, 300, 600])
            expect(await reader.rows.readRange(0, rows.length + 1)).toEqual(messagesBefore)
            expect(await reader.log.head()).toEqual(headBefore)
            expect(await reader.log.since(0)).toEqual(commitsBefore)
        })

        it.each(["payload", "state"])("rebuilds unreadable %s metadata through the original CAS clear", async (invalid) => {
            await writer.replaceAll(records(rows))
            const initial = await subject()
            await initial.catchUp(WRITABLE)
            const meta = (await inspect.readMeta()) as TrajectoryMeta
            vi.spyOn(inspect, "readMeta").mockResolvedValueOnce(
                invalid === "payload" ? { ...meta, payloadVersion: 99 } : { ...meta, state: "unknown" },
            )
            const writes: Write[] = []
            const maintainer = await subject({ writes })
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            expect(writes.filter(({ kind }) => kind === "clear")).toHaveLength(1)
            expect((await inspect.readMeta())?.buildId).not.toBe(meta.buildId)
            await expectHealed(rows, [0, 300, 600])
        })

        it("applies the next commit incrementally after rebuilding a same-log head regression", async () => {
            await writer.replaceAll(records(rows))
            const builder = await subject()
            await builder.catchUp(WRITABLE)
            const built = (await inspect.readMeta()) as TrajectoryMeta
            await inspect.updateMeta(ready((await reader.log.head()).headSeq + 5), stampOf(built))
            const probe = newProbe()
            const writes: Write[] = []
            const maintainer = await subject({ probe, writes })
            await maintainer.catchUp(WRITABLE)

            const grown = [...rows, ...conversation(702, [300, 600, 701]).slice(rows.length)]
            await writer.insert(records(grown).slice(700))
            const readsBefore = probe.starts.length
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

            expect(writes.filter(({ kind }) => kind === "clear")).toHaveLength(1)
            expect(probe.starts.slice(readsBefore)).toEqual([600])
            await expectHealed(grown, [0, 300, 600, 701])
        })

        it("resumes an interrupted rebuild from its persisted cursor and carry after a restart", async () => {
            const long = conversation(1_100, [300, 700])
            await writer.replaceAll(records(long))
            const writes: Write[] = []
            const interrupted = await subject({ writes })
            const untilFirstSlice = { writable: () => !writes.some(({ kind }) => kind === "replaceFrom") }

            expect(await interrupted.catchUp(untilFirstSlice)).toBe("not_writable")
            // The flip came after the first slice; no further write transaction started.
            expect(writes.filter(({ kind }) => kind === "replaceFrom")).toHaveLength(1)
            expect((await inspect.readMeta())?.job?.nextOrdinal).toBe(TRAJECTORY_SLICE_ROWS)
            await interrupted.close()

            const probe = newProbe()
            const restarted = await subject({ probe })
            expect(await restarted.catchUp(WRITABLE)).toBe("ready")
            expect(probe.starts).toEqual([TRAJECTORY_SLICE_ROWS, 2 * TRAJECTORY_SLICE_ROWS])
            await expectHealed(long, [0, 300, 700])
        })

        it("rebases a resumed rebuild when a commit changed rows behind its cursor", async () => {
            const long = conversation(1_100, [50, 300, 700])
            await writer.replaceAll(records(long))
            const writes: Write[] = []
            const probe = newProbe()
            const maintainer = await subject({ probe, writes })
            const untilFirstSlice = { writable: () => !writes.some(({ kind }) => kind === "replaceFrom") }
            expect(await maintainer.catchUp(untilFirstSlice)).toBe("not_writable")

            const edited = promote(long, 100)
            await writer.replaceAll(records(edited), { firstChangedIndex: 100 })
            const readsBefore = probe.starts.length
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

            // Row 100 is behind the cursor at 500, so the job restarts at the turn holding row 99.
            expect(probe.starts.slice(readsBefore)).toEqual([50, 50 + TRAJECTORY_SLICE_ROWS, 50 + 2 * TRAJECTORY_SLICE_ROWS])
            await expectHealed(edited, [0, 50, 100, 300, 700])
        })

        it.each([
            [[250]],
            [[499]],
            [[500]],
            [[501]],
            [[499, 500]],
        ])("folds the same turns as a full fold with prompts at %j around the slice boundary", async (anchors) => {
            const split = conversation(1_001, anchors)
            await writer.replaceAll(records(split))
            const maintainer = await subject()

            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            await expectHealed(split, [0, ...anchors])
        })

        it("lets message commits land while a sliced rebuild is between slices", async () => {
            await writer.replaceAll(records(conversation(1_100, [300, 700])))
            const paused = gate()
            const probe = newProbe()
            probe.beforeRead = onRead(2, () => paused.opened)
            const maintainer = await subject({ probe })
            const run = maintainer.catchUp(WRITABLE)
            await until(() => probe.starts.length === 2)

            const grown = conversation(1_101, [300, 700])
            let timer: ReturnType<typeof setTimeout> | undefined
            const landed = await Promise.race([
                writer.insert(records(grown).slice(1_100)).then(() => "committed"),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve("blocked"), 2_000)
                }),
            ])
            clearTimeout(timer)
            expect(landed).toBe("committed")

            paused.open()
            expect(await run).toBe("ready")
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            await expectHealed(grown, [0, 300, 700])
        })
    })

    it.each(["equal", "reversed"])("does not add backoff or diagnostic retries for %s ts", async (order) => {
        const rows = conversation(600, [200, 500]).map((entry, ordinal) => ({
            ...entry,
            ts: order === "equal" ? 40 : 900 - ordinal,
        }))
        await writer.replaceAll(records(rows))
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        const { clock, sleeps } = fakeClock()
        const probe = newProbe()
        const maintainer = await subject({ probe, clock })
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
        expect(probe.starts).toEqual([0, 500])
        expect(sleeps).toEqual([])
        expect(warn).not.toHaveBeenCalled()
        await expectHealed(rows, [0, 200, 500])
    })

    it.each(["open", "read", "write"])("reports one actual %s failure and lets its existing owner retry", async (operation) => {
        const rows = conversation(8, [3])
        await writer.replaceAll(records(rows))
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        const store = recording(inspect, [])
        const messages = { ...reader, rows: { readRange: vi.fn(reader.rows.readRange) } }
        const openStore = vi.fn(async () => store)
        if (operation === "open") openStore.mockRejectedValueOnce(new Error("open failed"))
        if (operation === "read") messages.rows.readRange.mockRejectedValueOnce(new Error("read failed"))
        if (operation === "write") vi.spyOn(store, "replaceFrom").mockRejectedValueOnce(new Error("write failed"))
        const maintainer = new TrajectoryMaintainer({ instanceId: TASK_ID, messages, openStore })
        maintainers.push(maintainer)

        expect(await maintainer.catchUp(WRITABLE)).toBe("failed")
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(`TrajectoryCatchUpFailed: instance=${TASK_ID} ${operation} failed`),
        )
        expect((await inspect.readMeta())?.state).not.toBe("error")
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
        expect(warn).toHaveBeenCalledTimes(1)
        await expectHealed(rows, [0, 3])
    })

    it("does not write a slice after close even when direct write access still answers true", async () => {
        const rows = conversation(1_100, [300, 700])
        await writer.replaceAll(records(rows))
        const paused = gate()
        const probe = newProbe()
        probe.beforeRead = onRead(2, () => paused.opened)
        const writes: Write[] = []
        const maintainer = await subject({ probe, writes })
        const run = maintainer.catchUp(WRITABLE)
        await until(() => probe.starts.length === 2)
        const closing = maintainer.close()
        paused.open()
        expect(await run).toBe("stopped")
        await closing
        expect(writes.filter(({ kind }) => kind === "replaceFrom")).toHaveLength(1)
    })

    it("stops without a diagnostic when task deletion closes instance storage under a running job", async () => {
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        await writer.replaceAll(records(conversation(1_100, [300, 700])))
        const paused = gate()
        const probe = newProbe()
        probe.beforeRead = onRead(2, () => paused.opened)
        const maintainer = await subject({ probe })
        const run = maintainer.catchUp(WRITABLE)
        await until(() => probe.starts.length === 2)

        await closeInstanceStoragesUnder(documentsRoot)
        paused.open()

        expect(await run).toBe("stopped")
        expect(warn).not.toHaveBeenCalled()
    })
})
