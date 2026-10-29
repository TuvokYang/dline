import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closeInstanceStoragesUnder, ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../../instance"
import { INSTANCE_BACKEND_ENV, InstanceBackend } from "../../instance/InstanceBackends"
import { openTrajectoryRows, TRAJECTORY_WRITER } from "../openTrajectoryRows"
import {
    isCurrentTrajectory,
    stampOf,
    type TrajectoryMeta,
    type TrajectoryMetaUpdate,
    type TrajectoryRowStore,
    type TrajectoryTurnInput,
} from "../TrajectoryRowStore"
import { TRAJECTORY_META_KEY, TRAJECTORY_PAYLOAD_VERSION, TrajectoryMetaRow } from "../TrajectoryRows"

const BUILDER = 3

function turn(seq: number, overrides: Partial<TrajectoryTurnInput> = {}): TrajectoryTurnInput {
    return {
        seq,
        attemptSeq: 0,
        anchorTs: 1_000 + seq * 10,
        anchorOrdinal: seq * 4,
        prompt: `prompt ${seq}`,
        rounds: 1,
        toolUsage: [{ tool: "read_file", count: seq + 1 }],
        endsAttempt: false,
        tailTs: 1_000 + seq * 10 + 5,
        tailAskKind: null,
        ...overrides,
    }
}

function update(appliedCommitSeq: number, overrides: Partial<TrajectoryMetaUpdate> = {}): TrajectoryMetaUpdate {
    return { state: "ready", appliedCommitSeq, job: null, errorTs: null, ...overrides }
}

function applied(result: { applied: boolean; meta: TrajectoryMeta | null }): TrajectoryMeta {
    expect(result.applied).toBe(true)
    if (!result.meta) throw new Error("applied write returned no meta")
    return result.meta
}

describe.each([InstanceBackend.Sqlite, InstanceBackend.Jsonl])("TrajectoryRowStore on %s", (backend) => {
    let documentsRoot: string
    let root: string
    let store: TrajectoryRowStore

    beforeEach(async () => {
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-db-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        vi.stubEnv(INSTANCE_BACKEND_ENV, backend)
        root = (await ensureInstanceLayout({ taskId: "task-trajectory" })).root
        store = await openTrajectoryRows(root)
    })

    afterEach(async () => {
        await store.close().catch(() => undefined)
        await closeInstanceStoragesUnder(documentsRoot)
        vi.unstubAllEnvs()
        await rm(documentsRoot, { recursive: true, force: true })
    })

    async function seed(count: number): Promise<TrajectoryMeta> {
        const built = applied(await store.clear({ logId: "log-a", builderVersion: BUILDER }, null))
        return applied(
            await store.replaceFrom(
                0,
                Array.from({ length: count }, (_, seq) => turn(seq)),
                update(count),
                stampOf(built),
            ),
        )
    }

    it("creates the meta on the first clear and refuses a second clear that expects no meta", async () => {
        expect(await store.readMeta()).toBeNull()
        const created = applied(await store.clear({ logId: "log-a", builderVersion: BUILDER }, null))
        expect(created).toMatchObject({ state: "building", revision: 1, turnCount: 0, appliedCommitSeq: 0, logId: "log-a" })

        const second = await store.clear({ logId: "log-b", builderVersion: BUILDER }, null)
        expect(second.applied).toBe(false)
        expect(await store.readMeta()).toEqual(created)
    })

    it("replaces turns from a seq and writes turns and meta together", async () => {
        const seeded = await seed(3)
        expect(seeded.turnCount).toBe(3)

        const rewritten = applied(await store.replaceFrom(1, [turn(1, { prompt: "edited" })], update(4), stampOf(seeded)))

        const { meta, turns } = await store.readSnapshot(-1)
        expect(meta).toEqual(rewritten)
        expect(rewritten).toMatchObject({ turnCount: 2, appliedCommitSeq: 4, revision: seeded.revision + 1 })
        expect(turns.map((entry) => [entry.seq, entry.prompt, entry.revision])).toEqual([
            [0, "prompt 0", seeded.revision],
            [1, "edited", rewritten.revision],
        ])
    })

    it("returns only the turns written after a revision", async () => {
        const seeded = await seed(2)
        const appended = applied(await store.replaceFrom(2, [turn(2)], update(3), stampOf(seeded)))

        const delta = await store.readSnapshot(seeded.revision)
        expect(delta.meta?.revision).toBe(appended.revision)
        expect(delta.turns.map((entry) => entry.seq)).toEqual([2])
    })

    it("writes nothing for a stale stamp", async () => {
        const seeded = await seed(2)
        const stale = stampOf(seeded)
        applied(await store.updateMeta(update(5), stale))
        const before = await store.readSnapshot(-1)

        const rejected = await store.replaceFrom(0, [turn(0, { prompt: "lost" })], update(6), stale)

        expect(rejected.applied).toBe(false)
        expect(rejected.meta).toEqual(before.meta)
        expect(await store.readSnapshot(-1)).toEqual(before)
    })

    it("rejects a stamp captured before a rebuild that returned to the same applied seq and job", async () => {
        const seeded = await seed(2)
        const captured = stampOf(seeded)

        const rebuilt = applied(await store.clear({ logId: "log-a", builderVersion: BUILDER }, captured))
        const caughtUp = applied(
            await store.replaceFrom(0, [turn(0), turn(1)], update(seeded.appliedCommitSeq), stampOf(rebuilt)),
        )
        expect(caughtUp).toMatchObject({ appliedCommitSeq: seeded.appliedCommitSeq, job: seeded.job, turnCount: 2 })
        expect(caughtUp.buildId).not.toBe(seeded.buildId)

        const before = await store.readSnapshot(-1)
        expect((await store.updateMeta(update(9), captured)).applied).toBe(false)
        expect((await store.clear({ logId: "log-a", builderVersion: BUILDER }, captured)).applied).toBe(false)
        expect(await store.readSnapshot(-1)).toEqual(before)
    })

    it("compares jobs by value, not by key order", async () => {
        const built = applied(await store.clear({ logId: "log-a", builderVersion: BUILDER }, null))
        const job = { fromSeq: 0, nextOrdinal: 500, targetSeq: 7, carry: { seq: 2, lastTs: 9, openTurn: null } }
        const building = applied(await store.updateMeta(update(0, { state: "building", job }), stampOf(built)))

        const reordered = { carry: { openTurn: null, lastTs: 9, seq: 2 }, targetSeq: 7, nextOrdinal: 500, fromSeq: 0 }
        const result = await store.updateMeta(update(7), {
            revision: building.revision,
            buildId: building.buildId,
            job: reordered,
        })
        expect(applied(result)).toMatchObject({ state: "ready", job: null })
    })

    it("leaves the previous state when a write fails after deleting turns", async () => {
        const seeded = await seed(3)
        const before = await store.readSnapshot(-1)

        const invalid = { ...turn(1), prompt: 42 } as unknown as TrajectoryTurnInput
        await expect(store.replaceFrom(1, [invalid], update(4), stampOf(seeded))).rejects.toThrow()

        expect(await store.readSnapshot(-1)).toEqual(before)
    })

    it("refuses a gap, a non-dense batch and a lower applied seq without writing", async () => {
        const seeded = await seed(2)
        const before = await store.readSnapshot(-1)

        await expect(store.replaceFrom(3, [turn(3)], update(3), stampOf(seeded))).rejects.toThrow("TrajectoryInvalidWrite")
        await expect(store.replaceFrom(1, [turn(2)], update(3), stampOf(seeded))).rejects.toThrow("TrajectoryInvalidWrite")
        await expect(store.updateMeta(update(1), stampOf(seeded))).rejects.toThrow("TrajectoryCommitSeqRegression")

        expect(await store.readSnapshot(-1)).toEqual(before)
    })

    it("only increases revision, across clears", async () => {
        const revisions: number[] = []
        let meta = applied(await store.clear({ logId: "log-a", builderVersion: BUILDER }, null))
        revisions.push(meta.revision)
        meta = applied(await store.replaceFrom(0, [turn(0)], update(1), stampOf(meta)))
        revisions.push(meta.revision)
        meta = applied(await store.clear({ logId: "log-b", builderVersion: BUILDER }, stampOf(meta)))
        revisions.push(meta.revision)
        meta = applied(await store.updateMeta(update(0, { state: "error", errorTs: 77 }), stampOf(meta)))
        revisions.push(meta.revision)

        expect(revisions).toEqual([...revisions].sort((left, right) => left - right))
        expect(new Set(revisions).size).toBe(revisions.length)
        expect(meta).toMatchObject({ state: "error", errorTs: 77, logId: "log-b", turnCount: 0 })
    })

    it("finds the turn a row belongs to by its anchor ordinal", async () => {
        await seed(3) // anchors at ordinals 0, 4, 8

        expect((await store.findTurnContaining(0))?.seq).toBe(0)
        expect((await store.findTurnContaining(5))?.seq).toBe(1)
        expect((await store.findTurnContaining(8))?.seq).toBe(2)
        expect((await store.findTurnContaining(100))?.seq).toBe(2)
        expect((await store.readTurn(1))?.tailTs).toBe(turn(1).tailTs)
        expect(await store.readTurn(9)).toBeUndefined()
    })

    it("keeps turns and meta across a reopen", async () => {
        await seed(2)
        const before = await store.readSnapshot(-1)
        await store.close()

        store = await openTrajectoryRows(root)
        expect(await store.readSnapshot(-1)).toEqual(before)
    })

    it("reports an older builder version so the caller clears and rebuilds", async () => {
        const seeded = await seed(2)
        expect(isCurrentTrajectory(seeded, BUILDER)).toBe(true)
        expect(isCurrentTrajectory(seeded, BUILDER + 1)).toBe(false)

        const cleared = applied(await store.clear({ logId: "log-a", builderVersion: BUILDER + 1 }, stampOf(seeded)))
        expect(isCurrentTrajectory(cleared, BUILDER + 1)).toBe(true)
        expect((await store.readSnapshot(-1)).turns).toEqual([])
    })

    it("reports an older payload version and clears it without a schema conflict", async () => {
        await store.close()
        const storage = openInstanceStorage(root)
        const database = await storage.openDatabase(InstanceDatabase.Trajectory, TRAJECTORY_WRITER)
        await (await database.openStore(TrajectoryMetaRow)).upsert([
            new TrajectoryMetaRow({
                key: TRAJECTORY_META_KEY,
                payloadVersion: TRAJECTORY_PAYLOAD_VERSION - 1,
                builderVersion: BUILDER,
                logId: "log-old",
                buildId: "build-old",
                state: "replaying",
                revision: 41,
                appliedCommitSeq: 12,
                job: { cursor: "an older job shape" },
                turnCount: 9,
                errorTs: null,
            }),
        ])
        await storage.close()

        store = await openTrajectoryRows(root)
        const snapshot = await store.readSnapshot(-1)
        if (!snapshot.meta) throw new Error("expected the stored meta")
        expect(snapshot.meta).toMatchObject({ state: "unknown", job: null, revision: 41 })
        expect(snapshot.turns).toEqual([])
        expect(isCurrentTrajectory(snapshot.meta, BUILDER)).toBe(false)

        const cleared = applied(await store.clear({ logId: "log-new", builderVersion: BUILDER }, stampOf(snapshot.meta)))
        expect(cleared).toMatchObject({ payloadVersion: TRAJECTORY_PAYLOAD_VERSION, state: "building", revision: 42 })
        expect(isCurrentTrajectory(cleared, BUILDER)).toBe(true)
    })
})
