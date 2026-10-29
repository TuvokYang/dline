import type { TrajectoryFrame } from "@shared/proto-conversions/trajectory"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TrajectoryMeta, TrajectorySnapshot, TrajectoryTurn } from "../../storage/trajectory/TrajectoryRowStore"
import { type CommittedUiMessages, CommittedUiMessagesMissing } from "../CommittedUiMessages"
import type { TrajectoryMaintainer } from "../TrajectoryMaintainer"
import { type TrajectoryAccess, TrajectoryMaintainerRegistry } from "../TrajectoryMaintainerRegistry"
import { type TrajectoryMaintainerProvider, TrajectorySource, type TrajectoryStream } from "../TrajectorySource"

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
    readonly catchUp = vi.fn(async () => "ready" as const)
    readonly close = vi.fn(async () => undefined)

    write(seqs: readonly number[], options: { buildId?: string; turnCount?: number } = {}): void {
        const previous = this.meta
        const buildId = options.buildId ?? previous?.buildId ?? "build-1"
        if (previous && buildId !== previous.buildId) this.turns.clear()
        const revision = (previous?.revision ?? 0) + 1
        for (const seq of seqs) this.turns.set(seq, turn(seq, revision))
        const turnCount = options.turnCount ?? Math.max(previous?.turnCount ?? 0, ...seqs.map((seq) => seq + 1))
        for (const seq of [...this.turns.keys()]) if (seq >= turnCount) this.turns.delete(seq)
        this.meta = meta({ buildId, revision, turnCount })
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

function meta(fields: Pick<TrajectoryMeta, "buildId" | "revision" | "turnCount">): TrajectoryMeta {
    return {
        payloadVersion: 1,
        builderVersion: 1,
        logId: "log-1",
        state: "ready",
        appliedCommitSeq: fields.revision,
        job: null,
        errorTs: null,
        ...fields,
    }
}

function turn(seq: number, revision: number): TrajectoryTurn {
    return {
        seq,
        attemptSeq: 0,
        anchorTs: 1_000 + seq,
        anchorOrdinal: seq * 3,
        prompt: `prompt ${seq}`,
        rounds: 1,
        toolUsage: [],
        endsAttempt: false,
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
    let turns = new Map<number, number>()
    const send = vi.fn(async (frame: TrajectoryFrame) => {
        const previous = frames.at(-1)
        if (!frame.reset) {
            // A delta must extend exactly the frame before it.
            expect(frame.baseRevision).toBe(previous?.revision)
        } else {
            turns = new Map()
        }
        frames.push(frame)
        for (const entry of frame.turns) turns.set(entry.seq, entry.anchorTs)
        for (const seq of [...turns.keys()]) if (seq >= frame.turnCount) turns.delete(seq)
    })
    return { frames, send, seqs: () => [...turns.keys()].sort((a, b) => a - b) }
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
    })

    it("opens with a full reset even when the cache is far past revision 0", async () => {
        const fake = new FakeTrajectory()
        for (let seq = 0; seq < 3; seq++) fake.write([seq])
        const view = receiver()

        subscribe(new TrajectorySource(switchableAccess(true).access, provider(fake).maintainers), view.send)

        await vi.waitFor(() => expect(view.frames).toHaveLength(1))
        expect(view.frames[0]).toMatchObject({ state: "ready", reset: true, revision: 3, baseRevision: 0, turnCount: 3 })
        expect(view.seqs()).toEqual([0, 1, 2])
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
        expect(view.frames[1].turns.map((entry) => entry.seq)).toEqual([2])

        fake.write([0], { turnCount: 1 })
        await vi.waitFor(() => expect(view.frames).toHaveLength(3))
        expect(view.seqs()).toEqual([0])
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
        expect(frame.turns.map((entry) => entry.seq)).toEqual([0, 1])

        create.mockClear()
        const denied = await new TrajectorySource(switchableAccess(false).access, maintainers).snapshot()
        expect(denied).toMatchObject({ state: "unavailable", reset: true, turns: [] })
        expect(create).not.toHaveBeenCalled()
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
