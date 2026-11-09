import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TrajectoryFrame, TrajectoryFrameTurn } from "@shared/proto-conversions/trajectory"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { closeInstanceStoragesUnder, ensureInstanceLayout } from "../../storage/instance"
import { openUiMessageRows, UI_MESSAGE_WRITER } from "../../storage/messages/openUiMessageRows"
import type { TrajectoryMeta, TrajectorySnapshot, TrajectoryTurn } from "../../storage/trajectory/TrajectoryRowStore"
import { type CommittedUiMessages, CommittedUiMessagesMissing } from "../CommittedUiMessages"
import { type CatchUpOutcome, TRAJECTORY_BUILDER_VERSION, type TrajectoryMaintainer } from "../TrajectoryMaintainer"
import { type TrajectoryAccess, TrajectoryMaintainerRegistry } from "../TrajectoryMaintainerRegistry"
import {
    type TrajectoryMaintainerProvider,
    TrajectorySource,
    type TrajectoryStream,
    taskTrajectoryMaintainers,
} from "../TrajectorySource"

/**
 * An in-memory trajectory cache behind the maintainer surface the source uses.
 * Its revisions, builds and truncations follow the `trajectory.db` contract:
 * every write bumps the revision, and a rebuild changes the build id.
 */
class FakeTrajectory {
    meta: TrajectoryMeta | null = null
    private readonly turns = new Map<number, TrajectoryTurn>()
    private readonly listeners = new Set<(meta: TrajectoryMeta) => void>()
    /** Awaited after a snapshot has been read and before it is returned. */
    readGate: Promise<void> | undefined
    readonly catchUp = vi.fn(async (): Promise<CatchUpOutcome> => "ready")
    readonly close = vi.fn(async () => undefined)

    write(
        seqs: readonly number[],
        options: { buildId?: string; turnCount?: number; state?: TrajectoryMeta["state"] } = {},
    ): void {
        const previous = this.meta
        const buildId = options.buildId ?? previous?.buildId ?? "build-1"
        if (previous && buildId !== previous.buildId) this.turns.clear()
        const revision = (previous?.revision ?? 0) + 1
        for (const seq of seqs) this.turns.set(seq, turn(seq, revision))
        const turnCount = options.turnCount ?? Math.max(previous?.turnCount ?? 0, ...seqs.map((seq) => seq + 1))
        for (const seq of [...this.turns.keys()]) if (seq >= turnCount) this.turns.delete(seq)
        this.meta = meta({ buildId, revision, turnCount, state: options.state ?? "ready" })
        for (const listener of [...this.listeners]) listener(this.meta)
    }

    async readSnapshot(sinceRevision: number): Promise<TrajectorySnapshot> {
        const snapshot = {
            meta: this.meta,
            turns: [...this.turns.values()].filter((entry) => entry.revision > sinceRevision).sort((a, b) => a.seq - b.seq),
        }
        await this.readGate
        return snapshot
    }

    onDidWrite(listener: (meta: TrajectoryMeta) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }
}

function meta(fields: Pick<TrajectoryMeta, "buildId" | "revision" | "turnCount" | "state">): TrajectoryMeta {
    return {
        payloadVersion: 1,
        builderVersion: TRAJECTORY_BUILDER_VERSION,
        logId: "log-1",
        appliedCommitSeq: fields.revision,
        job: null,
        errorTs: null,
        ...fields,
    }
}

function turn(seq: number, revision: number): TrajectoryTurn {
    return {
        seq,
        attemptSeq: seq < 2 ? 0 : 1,
        anchorTs: seq < 2 ? 40 : 40 - seq,
        anchorOrdinal: seq === 0 ? 0 : seq * 5 + 2,
        prompt: `prompt ${seq}`,
        rounds: seq + 1,
        toolUsage: [{ tool: "readFile", count: seq + 2 }],
        endsAttempt: seq === 1,
        tailTs: 1_001 + seq,
        tailAskKind: null,
        revision,
    }
}

function switchableAccess(initial: boolean): { readonly access: TrajectoryAccess; set(writable: boolean): void } {
    let writable = initial
    const listeners = new Set<() => void>()
    return {
        access: {
            writable: () => writable,
            onDidChange: (listener) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
        },
        set(next) {
            writable = next
            for (const listener of [...listeners]) listener()
        },
    }
}

function provider(fake: FakeTrajectory) {
    const create = vi.fn(async () => ({
        maintainer: fake as unknown as TrajectoryMaintainer,
        messages: {
            signals: { subscribe: () => () => undefined },
            close: async () => undefined,
        } as unknown as CommittedUiMessages,
    }))
    const maintainers: TrajectoryMaintainerProvider = { key: "task-root", registry: new TrajectoryMaintainerRegistry(), create }
    return { maintainers, create }
}

/** The receiver's view of a stream, applied frame by frame as the Webview applies it. */
function receiver() {
    const frames: TrajectoryFrame[] = []
    let turns = new Map<number, TrajectoryFrameTurn>()
    const send = vi.fn(async (frame: TrajectoryFrame) => {
        const previous = frames.at(-1)
        if (!frame.reset) {
            // A delta must extend exactly the frame before it.
            expect(frame.baseRevision).toBe(previous?.revision)
        } else {
            turns = new Map()
        }
        frames.push(frame)
        for (const entry of frame.turns) turns.set(entry.seq, entry)
        for (const seq of [...turns.keys()]) if (seq >= frame.turnCount) turns.delete(seq)
    })
    return {
        frames,
        send,
        seqs: () => [...turns.keys()].sort((a, b) => a - b),
        turns: () => [...turns.values()].sort((a, b) => a.seq - b.seq),
    }
}

describe("TrajectorySource", () => {
    const streams: TrajectoryStream[] = []
    const subscribe = (
        source: TrajectorySource,
        send: (frame: TrajectoryFrame) => Promise<void>,
        onFailed: () => void = () => undefined,
    ) => {
        const stream = source.subscribe(send, onFailed)
        streams.push(stream)
        return stream
    }

    afterEach(async () => {
        await Promise.all(streams.splice(0).map((stream) => stream.close()))
        vi.restoreAllMocks()
    })

    it("opens with a full reset even when the cache is far past revision 0", async () => {
        const fake = new FakeTrajectory()
        for (let seq = 0; seq < 3; seq++) fake.write([seq])
        const view = receiver()

        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send)

        await vi.waitFor(() => expect(view.frames).toHaveLength(1))
        expect(view.frames[0]).toMatchObject({ state: "ready", reset: true, revision: 3, baseRevision: 0, turnCount: 3 })
        expect(view.seqs()).toEqual([0, 1, 2])
        expect(
            view.turns().map(({ anchorIndex, anchorTs, attemptSeq, rounds, toolUsage, endsAttempt }) => ({
                anchorIndex,
                anchorTs,
                attemptSeq,
                rounds,
                toolUsage,
                endsAttempt,
            })),
        ).toEqual([
            {
                anchorIndex: 0,
                anchorTs: 40,
                attemptSeq: 0,
                rounds: 1,
                toolUsage: [{ tool: "readFile", count: 2 }],
                endsAttempt: false,
            },
            {
                anchorIndex: 7,
                anchorTs: 40,
                attemptSeq: 0,
                rounds: 2,
                toolUsage: [{ tool: "readFile", count: 3 }],
                endsAttempt: true,
            },
            {
                anchorIndex: 12,
                anchorTs: 38,
                attemptSeq: 1,
                rounds: 3,
                toolUsage: [{ tool: "readFile", count: 4 }],
                endsAttempt: false,
            },
        ])
    })

    it("folds before the first snapshot, so the opening frame already carries the turns", async () => {
        // A task that has never been folded has no meta and no turns. Reading
        // first would send an empty `building` reset that claims a healthy
        // trajectory while the rail has nothing to draw.
        const fake = new FakeTrajectory()
        fake.catchUp.mockImplementation(async () => {
            fake.write([0, 1])
            return "ready"
        })
        const view = receiver()

        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send)

        await vi.waitFor(() => expect(view.frames).toHaveLength(1))
        // The registry also folds on its own schedule; what matters is that a
        // fold ran before the frame, not how many runners asked for one.
        expect(fake.catchUp).toHaveBeenCalled()
        expect(view.frames[0]).toMatchObject({ reset: true, state: "ready", turnCount: 2 })
        expect(view.seqs()).toEqual([0, 1])
    })

    it.each(["not_writable", "stopped"] as const)("does not read an uncaught-up cache after %s", async (outcome) => {
        const fake = new FakeTrajectory()
        fake.write([0])
        fake.catchUp.mockResolvedValue(outcome)
        const reading = vi.spyOn(fake, "readSnapshot")
        const view = receiver()
        const access = switchableAccess(true)
        subscribe(new TrajectorySource(access.access, provider(fake).maintainers), view.send)
        await vi.waitFor(() => expect(fake.catchUp).toHaveBeenCalled())
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(reading).not.toHaveBeenCalled()
        expect(view.frames).toEqual([])
        access.set(false)
        await vi.waitFor(() => expect(view.frames).toHaveLength(1))
        expect(view.frames[0].state).toBe("unavailable")
        fake.catchUp.mockResolvedValue("ready")
        access.set(true)
        await vi.waitFor(() => expect(view.frames).toHaveLength(2))
        expect(view.frames[1]).toMatchObject({ state: "ready", reset: true, turnCount: 1 })
    })

    it("sends later writes, including a truncation, as frames based on the previous one", async () => {
        const fake = new FakeTrajectory()
        fake.write([0, 1])
        const view = receiver()
        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send)
        await vi.waitFor(() => expect(view.frames).toHaveLength(1))

        fake.write([2])
        await vi.waitFor(() => expect(view.frames).toHaveLength(2))
        expect(view.frames[1]).toMatchObject({ reset: false, baseRevision: 1, revision: 2, turnCount: 3 })
        expect(view.frames[1].turns.map((entry) => [entry.seq, entry.anchorIndex, entry.anchorTs])).toEqual([[2, 12, 38]])
        expect(view.turns().map((entry) => [entry.seq, entry.anchorIndex, entry.rounds, entry.toolUsage[0].count])).toEqual([
            [0, 0, 1, 2],
            [1, 7, 2, 3],
            [2, 12, 3, 4],
        ])

        fake.write([0], { turnCount: 1 })
        await vi.waitFor(() => expect(view.frames).toHaveLength(3))
        expect(view.seqs()).toEqual([0])
        expect(view.turns().map((entry) => entry.anchorIndex)).toEqual([0])
    })

    it("delivers a write published while the opening snapshot was being read", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        let release: () => void = () => undefined
        fake.readGate = new Promise((resolve) => {
            release = resolve
        })
        const reading = vi.spyOn(fake, "readSnapshot")
        const view = receiver()
        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send)
        await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1))

        // The snapshot is already read; this write lands before it is returned.
        fake.write([1])
        fake.readGate = undefined
        release()

        await vi.waitFor(() => expect(view.seqs()).toEqual([0, 1]))
        expect(view.frames[0]).toMatchObject({ reset: true, revision: 1 })
        expect(view.frames.at(-1)).toMatchObject({ reset: false, revision: 2 })
        expect(view.turns().map((entry) => [entry.anchorIndex, entry.anchorTs])).toEqual([
            [0, 40],
            [7, 40],
        ])
    })

    it("delivers a write published while a frame was being delivered", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        const view = receiver()
        let deliver: () => void = () => undefined
        const delivered = new Promise<void>((resolve) => {
            deliver = resolve
        })
        const slowSend = vi.fn(async (frame: TrajectoryFrame) => {
            if (view.frames.length === 0) await delivered
            await view.send(frame)
        })
        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), slowSend)
        await vi.waitFor(() => expect(slowSend).toHaveBeenCalledTimes(1))

        fake.write([1])
        deliver()

        await vi.waitFor(() => expect(view.seqs()).toEqual([0, 1]))
        expect(slowSend).toHaveBeenCalledTimes(2)
        expect(view.turns().map((entry) => [entry.anchorIndex, entry.anchorTs])).toEqual([
            [0, 40],
            [7, 40],
        ])
    })

    it("starts again from a full reset when the cache is rebuilt", async () => {
        const fake = new FakeTrajectory()
        fake.write([0, 1, 2])
        const view = receiver()
        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send)
        await vi.waitFor(() => expect(view.frames).toHaveLength(1))

        fake.write([0], { buildId: "build-2", turnCount: 1 })

        await vi.waitFor(() => expect(view.frames).toHaveLength(2))
        expect(view.frames[1]).toMatchObject({ reset: true, baseRevision: 0, revision: 2, turnCount: 1 })
        expect(view.seqs()).toEqual([0])
        expect(view.turns().map((entry) => entry.anchorIndex)).toEqual([0])
    })

    it("publishes actual BUILDING and ERROR contents without a last-good substitute", async () => {
        const fake = new FakeTrajectory()
        fake.write([0, 1])
        const view = receiver()
        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send)
        await vi.waitFor(() => expect(view.frames).toHaveLength(1))
        fake.write([0], { buildId: "building", state: "building", turnCount: 1 })
        await vi.waitFor(() => expect(view.frames).toHaveLength(2))
        expect(view.frames[1]).toMatchObject({ state: "building", reset: true, turnCount: 1 })
        expect(view.seqs()).toEqual([0])
        fake.write([1], { state: "error" })
        await vi.waitFor(() => expect(view.frames).toHaveLength(3))
        expect(view.frames[2]).toMatchObject({ state: "error", reset: false, turnCount: 2 })
        expect(view.turns().map((entry) => [entry.seq, entry.anchorIndex, entry.anchorTs])).toEqual([
            [0, 0, 40],
            [1, 7, 40],
        ])
        fake.write([2])
        await vi.waitFor(() => expect(view.frames).toHaveLength(4))
        expect(view.frames[3].state).toBe("ready")
        expect(view.turns().map((entry) => entry.anchorIndex)).toEqual([0, 7, 12])
    })

    it("reports unavailable without creating a maintainer, and resumes from a reset when access returns", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        const { maintainers, create } = provider(fake)
        const access = switchableAccess(false)
        const view = receiver()
        subscribe(new TrajectorySource(access.access, maintainers), view.send)

        await vi.waitFor(() => expect(view.frames).toHaveLength(1))
        expect(view.frames[0]).toMatchObject({ state: "unavailable", reset: true, turnCount: 0 })
        expect(create).not.toHaveBeenCalled()

        access.set(true)
        await vi.waitFor(() => expect(view.frames).toHaveLength(2))
        expect(view.frames[1]).toMatchObject({ state: "ready", reset: true, revision: 1 })

        access.set(false)
        await vi.waitFor(() => expect(view.frames).toHaveLength(3))
        expect(view.frames[2]).toMatchObject({ state: "unavailable", reset: true })
        // Losing access released the only hold, which closes the maintainer and its databases.
        expect(fake.close).toHaveBeenCalledTimes(1)
    })

    it("stops sending and releases the maintainer once closed", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        const view = receiver()
        const onFailed = vi.fn()
        const stream = subscribe(
            new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers),
            view.send,
            onFailed,
        )
        await vi.waitFor(() => expect(view.frames).toHaveLength(1))

        await stream.close()
        fake.write([1])
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(view.frames).toHaveLength(1)
        expect(fake.close).toHaveBeenCalledTimes(1)
        // Closing is the owner's own decision, not a failure to report back.
        expect(onFailed).not.toHaveBeenCalled()
    })

    it("reports a failure to create the maintainer once, and then ignores access changes", async () => {
        const fake = new FakeTrajectory()
        const { maintainers, create } = provider(fake)
        create.mockRejectedValueOnce(new Error("disk unavailable"))
        const access = switchableAccess(true)
        const view = receiver()
        const onFailed = vi.fn()

        subscribe(new TrajectorySource(access.access, maintainers), view.send, onFailed)
        await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1))

        access.set(false)
        access.set(true)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(view.frames).toEqual([])
        expect(create).toHaveBeenCalledTimes(1)
        expect(onFailed).toHaveBeenCalledTimes(1)
    })

    it("releases the maintainer before reporting a snapshot that cannot be read", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        vi.spyOn(fake, "readSnapshot").mockRejectedValueOnce(new Error("trajectory.db is corrupt"))
        const view = receiver()
        let releasedWhenReported: boolean | undefined
        const onFailed = vi.fn(() => {
            releasedWhenReported = fake.close.mock.calls.length === 1
        })

        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send, onFailed)

        await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1))
        expect(releasedWhenReported).toBe(true)
        expect(view.frames).toEqual([])
    })

    it("releases once after a failed catch-up without reading or substituting a stale reset", async () => {
        const fake = new FakeTrajectory()
        fake.write([0, 1])
        fake.catchUp.mockResolvedValue("failed")
        const reading = vi.spyOn(fake, "readSnapshot")
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        const view = receiver()
        const onFailed = vi.fn(() => expect(fake.close).toHaveBeenCalledTimes(1))
        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send, onFailed)
        await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1))
        expect(reading).not.toHaveBeenCalled()
        expect(view.frames).toEqual([])
        // The real maintainer owns and reports this failure, not a second Source catch.
        expect(warn).not.toHaveBeenCalled()
    })

    it("fails at the stream boundary when catch-up unexpectedly rejects", async () => {
        const fake = new FakeTrajectory()
        fake.catchUp.mockRejectedValue(new Error("catch-up rejected"))
        // The real registry consumes outcomes, not rejecting maintainer doubles.
        // Isolate the source operation so no fire-and-forget registry run rejects.
        const release = vi.fn(async () => undefined)
        const registry = { acquire: async () => ({ maintainer: fake, release }) } as unknown as TrajectoryMaintainerRegistry
        const { maintainers } = provider(fake)
        const view = receiver()
        const onFailed = vi.fn(() => expect(release).toHaveBeenCalledTimes(1))
        subscribe(new TrajectorySource(switchableAccess(true).access, { ...maintainers, registry }), view.send, onFailed)
        await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1))
        expect(view.frames).toEqual([])
    })

    it("reports a send failure once after release and does not send subsequent writes", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        const send = vi.fn(async () => {
            throw new Error("send failed")
        })
        const onFailed = vi.fn(() => expect(fake.close).toHaveBeenCalledTimes(1))
        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), send, onFailed)
        await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1))
        fake.write([1])
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(send).toHaveBeenCalledTimes(1)
        expect(onFailed).toHaveBeenCalledTimes(1)
    })

    it("does not report a failure once the owner closed while the maintainer was being released", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        vi.spyOn(fake, "readSnapshot").mockRejectedValueOnce(new Error("trajectory.db is corrupt"))
        let finishRelease: () => void = () => undefined
        fake.close.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    finishRelease = () => resolve(undefined)
                }),
        )
        const onFailed = vi.fn()
        const stream = subscribe(
            new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers),
            receiver().send,
            onFailed,
        )
        await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1))

        const closing = stream.close()
        finishRelease()
        await closing

        expect(onFailed).not.toHaveBeenCalled()
    })

    it("reads nothing when access is lost while the maintainer is being created", async () => {
        const fake = new FakeTrajectory()
        fake.write([0])
        const { maintainers, create } = provider(fake)
        let finishCreate: () => void = () => undefined
        const created = new Promise<void>((resolve) => {
            finishCreate = resolve
        })
        const createMaintained = create.getMockImplementation()
        create.mockImplementationOnce(async () => {
            await created
            return (await createMaintained?.()) as Awaited<ReturnType<typeof create>>
        })
        const reading = vi.spyOn(fake, "readSnapshot")
        const access = switchableAccess(true)
        const view = receiver()
        subscribe(new TrajectorySource(access.access, maintainers), view.send)
        await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))

        access.set(false)
        finishCreate()

        await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1))
        expect(reading).not.toHaveBeenCalled()
        expect(view.frames).toHaveLength(1)
        expect(view.frames[0]).toMatchObject({ state: "unavailable", reset: true })
    })

    it("answers a one-off snapshot only after catching up, and unavailable without access", async () => {
        const fake = new FakeTrajectory()
        fake.catchUp.mockImplementation(async () => {
            fake.write([0, 1])
            return "ready"
        })
        const { maintainers, create } = provider(fake)

        const frame = await new TrajectorySource(switchableAccess(true).access, maintainers).snapshot()
        expect(frame).toMatchObject({ state: "ready", reset: true, turnCount: 2 })
        expect(frame.turns.map((entry) => [entry.seq, entry.anchorIndex, entry.anchorTs])).toEqual([
            [0, 0, 40],
            [1, 7, 40],
        ])

        create.mockClear()
        const denied = await new TrajectorySource(switchableAccess(false).access, maintainers).snapshot()
        expect(denied).toMatchObject({ state: "unavailable", reset: true, turns: [] })
        expect(create).not.toHaveBeenCalled()
    })

    it("rejects a one-off failed catch-up and releases without reading the old cache", async () => {
        const fake = new FakeTrajectory()
        fake.write([0, 1])
        fake.catchUp.mockResolvedValue("failed")
        const reading = vi.spyOn(fake, "readSnapshot")
        const { maintainers } = provider(fake)
        await expect(new TrajectorySource(switchableAccess(true).access, maintainers).snapshot()).rejects.toThrow(
            "Trajectory catch-up failed before snapshot",
        )
        expect(fake.close).toHaveBeenCalledTimes(1)
        expect(reading).not.toHaveBeenCalled()
    })

    it("answers a one-off snapshot with unavailable while the task has no messages.db, and fails on other errors", async () => {
        const { maintainers, create } = provider(new FakeTrajectory())
        create.mockRejectedValueOnce(new CommittedUiMessagesMissing("task"))
        const missing = await new TrajectorySource(switchableAccess(true).access, maintainers).snapshot()
        expect(missing).toMatchObject({ state: "unavailable", reset: true, turns: [] })

        create.mockRejectedValueOnce(new Error("disk unavailable"))
        await expect(new TrajectorySource(switchableAccess(true).access, maintainers).snapshot()).rejects.toThrow(
            "disk unavailable",
        )
    })
})

describe("TrajectorySource committed-store wiring", () => {
    it("publishes source indices and counts through the production provider after committed edits", async () => {
        const documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-source-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        let stream: TrajectoryStream | undefined
        try {
            const taskId = "task-source-wiring"
            const { root } = await ensureInstanceLayout({ taskId })
            const writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
            const message = (fields: Partial<UiMessage>): UiMessage => ({ ts: 90, type: "say", ...fields }) as UiMessage
            const tool = () => message({ ts: 85, say: "tool", text: JSON.stringify({ tool: "readFile" }) })
            const initial = [
                message({ say: "task", text: "first" }),
                message({ say: "api_req_started", text: "{}" }),
                tool(),
                message({ say: "user_feedback", text: "second" }),
                tool(),
                message({ ts: 82, type: "ask", ask: "completion_result", text: "done" }),
                message({ ts: 80, say: "user_feedback", text: "third" }),
            ]
            const records = (messages: readonly UiMessage[]) =>
                messages.map((entry, ordinal) => ({ ordinal, ts: entry.ts, message: entry }))
            await writer.replaceAll(records(initial))
            const maintainers = await taskTrajectoryMaintainers(taskId)
            expect(maintainers.key).toBe(root)
            const source = new TrajectorySource(switchableAccess(true).access, maintainers)
            const oneOff = await source.snapshot()
            expect(
                oneOff.turns.map(({ seq, anchorIndex, anchorTs, attemptSeq, rounds, toolUsage, endsAttempt }) => [
                    seq,
                    anchorIndex,
                    anchorTs,
                    attemptSeq,
                    rounds,
                    toolUsage,
                    endsAttempt,
                ]),
            ).toEqual([
                [0, 0, 90, 0, 1, [{ tool: "readFile", count: 1 }], false],
                [1, 3, 90, 0, 0, [{ tool: "readFile", count: 1 }], true],
                [2, 6, 80, 1, 0, [], false],
            ])
            const view = receiver()
            const onFailed = vi.fn()
            stream = source.subscribe(view.send, onFailed)
            await vi.waitFor(() => expect(view.frames).toHaveLength(1), { timeout: 5_000 })
            expect(view.turns()).toEqual(oneOff.turns)

            const grown = [
                ...initial,
                tool(),
                message({ ts: 80, say: "api_req_started", text: "{}" }),
                message({ ts: 79, say: "user_feedback", text: "fourth" }),
                tool(),
            ]
            await writer.insert(records(grown).slice(initial.length))
            await vi.waitFor(() => expect(view.turns().map((turn) => turn.anchorIndex)).toEqual([0, 3, 6, 9]), { timeout: 5_000 })
            expect(
                view
                    .turns()
                    .map(({ attemptSeq, rounds, toolUsage, endsAttempt }) => [attemptSeq, rounds, toolUsage, endsAttempt]),
            ).toEqual([
                [0, 1, [{ tool: "readFile", count: 1 }], false],
                [0, 0, [{ tool: "readFile", count: 1 }], true],
                [1, 1, [{ tool: "readFile", count: 1 }], false],
                [1, 0, [{ tool: "readFile", count: 1 }], false],
            ])

            const inserted = [...grown.slice(0, 3), message({ say: "user_feedback", text: "inserted" }), ...grown.slice(3)]
            await writer.replaceAll(records(inserted), { firstChangedIndex: 3 })
            await vi.waitFor(() => expect(view.turns().map((turn) => turn.anchorIndex)).toEqual([0, 3, 4, 7, 10]), {
                timeout: 5_000,
            })
            expect(view.turns().map((turn) => [turn.prompt, turn.attemptSeq, turn.rounds, turn.toolUsage])).toEqual([
                ["first", 0, 1, [{ tool: "readFile", count: 1 }]],
                ["inserted", 0, 0, []],
                ["second", 0, 0, [{ tool: "readFile", count: 1 }]],
                ["third", 1, 1, [{ tool: "readFile", count: 1 }]],
                ["fourth", 1, 0, [{ tool: "readFile", count: 1 }]],
            ])

            await writer.replaceAll(records(inserted.slice(0, 5)), { firstChangedIndex: 5 })
            await vi.waitFor(() => expect(view.turns().map((turn) => turn.anchorIndex)).toEqual([0, 3, 4]), { timeout: 5_000 })
            expect(view.frames.at(-1)).toMatchObject({ reset: false, turnCount: 3, state: "ready" })
            expect(view.turns().map((turn) => [turn.attemptSeq, turn.rounds, turn.toolUsage, turn.endsAttempt])).toEqual([
                [0, 1, [{ tool: "readFile", count: 1 }], false],
                [0, 0, [], false],
                [0, 0, [], false],
            ])
            expect(onFailed).not.toHaveBeenCalled()
            await stream.close()
            stream = undefined
            await writer.close()
        } finally {
            await stream?.close()
            await closeInstanceStoragesUnder(documentsRoot)
            vi.unstubAllEnvs()
            await rm(documentsRoot, { recursive: true, force: true })
        }
    })

    it("reports a real catch-up I/O failure once after release, then rebuilds on a later acquisition", async () => {
        const documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-source-failure-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        let stream: TrajectoryStream | undefined
        try {
            const taskId = "task-source-failure"
            const { root } = await ensureInstanceLayout({ taskId })
            const writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
            const initial: UiMessage[] = [
                { ts: 40, type: "say", say: "task", text: "first" },
                { ts: 40, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile" }) },
            ]
            const records = (messages: readonly UiMessage[]) =>
                messages.map((message, ordinal) => ({ ordinal, ts: message.ts, message }))
            await writer.replaceAll(records(initial))
            const maintainers = await taskTrajectoryMaintainers(taskId)
            const events: string[] = []
            const readSnapshot = vi.fn()
            const failing: TrajectoryMaintainerProvider = {
                ...maintainers,
                create: async () => {
                    const task = await maintainers.create()
                    vi.spyOn(task.messages.rows, "readRange").mockRejectedValueOnce(new Error("committed read failed"))
                    const read = task.maintainer.readSnapshot.bind(task.maintainer)
                    vi.spyOn(task.maintainer, "readSnapshot").mockImplementation((revision) => {
                        readSnapshot()
                        return read(revision)
                    })
                    const close = task.messages.close
                    vi.spyOn(task.messages, "close").mockImplementation(async () => {
                        await close()
                        events.push("released")
                    })
                    return task
                },
            }
            const view = receiver()
            const onFailed = vi.fn(() => {
                events.push("failed")
            })
            stream = new TrajectorySource(switchableAccess(true).access, failing).subscribe(view.send, onFailed)
            await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1), { timeout: 5_000 })
            expect(events).toEqual(["released", "failed"])
            expect(readSnapshot).not.toHaveBeenCalled()
            expect(view.frames).toEqual([])
            expect(warn.mock.calls.filter(([message]) => String(message).startsWith("[trajectory]"))).toHaveLength(1)
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("TrajectoryCatchUpFailed:"))
            await stream.close()
            stream = undefined

            const grown: UiMessage[] = [
                ...initial,
                { ts: 39, type: "say", say: "user_feedback", text: "next" },
                { ts: 38, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile" }) },
            ]
            await writer.insert(records(grown).slice(initial.length))
            const healed = await new TrajectorySource(switchableAccess(true).access, maintainers).snapshot()
            expect(healed.state).toBe("ready")
            expect(healed.turns.map((turn) => [turn.anchorIndex, turn.anchorTs, turn.toolUsage])).toEqual([
                [0, 40, [{ tool: "readFile", count: 1 }]],
                [2, 39, [{ tool: "readFile", count: 1 }]],
            ])
            expect(warn.mock.calls.filter(([message]) => String(message).startsWith("[trajectory]"))).toHaveLength(1)
            await writer.close()
        } finally {
            await stream?.close()
            await closeInstanceStoragesUnder(documentsRoot)
            vi.restoreAllMocks()
            vi.unstubAllEnvs()
            await rm(documentsRoot, { recursive: true, force: true })
        }
    })
})
