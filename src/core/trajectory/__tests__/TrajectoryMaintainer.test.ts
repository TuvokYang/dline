import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { closeInstanceStoragesUnder, ensureInstanceLayout } from "../../storage/instance"
import { openUiMessageRows, UI_MESSAGE_WRITER } from "../../storage/messages/openUiMessageRows"
import type { UiMessageRowStore } from "../../storage/messages/UiMessageRowStore"
import type { UiMessageRecord } from "../../storage/messages/UiMessageRows"
import { openTrajectoryRows } from "../../storage/trajectory/openTrajectoryRows"
import type { TrajectoryRowStore } from "../../storage/trajectory/TrajectoryRowStore"
import { UIMessage } from "../../storage/UIMessage"
import type { CommittedUiMessages } from "../CommittedUiMessages"
import { closeOpenTurn, EMPTY_FOLD_CARRY, foldTrajectory } from "../foldTrajectory"
import { TRAJECTORY_SLICE_ROWS, TrajectoryMaintainer } from "../TrajectoryMaintainer"

const WRITABLE = { writable: () => true }

let nextTs = 1_000
function message(fields: Partial<UiMessage>): UiMessage {
    nextTs += 10
    return { ts: nextTs, type: "say", ...fields } as UiMessage
}
const task = (text: string) => message({ say: "task", text })
const user = (text: string) => message({ say: "user_feedback", text })
const tool = () => message({ say: "tool", text: JSON.stringify({ tool: "readFile", path: "a.ts" }) })
const checkpoint = () => message({ say: "checkpoint_created", text: "", lastCheckpointHash: [] })
const compactionCard = () =>
    message({ say: "tool", text: JSON.stringify({ tool: "summarizeTask", content: "summary", compactionStatus: "completed" }) })

/** `rows` with `entry` inserted at `ordinal`, its ts between the neighbours it lands between. */
function insertAt(rows: readonly UiMessage[], ordinal: number, entry: UiMessage): UiMessage[] {
    return [...rows.slice(0, ordinal), { ...entry, ts: rows[ordinal - 1].ts + 5 }, ...rows.slice(ordinal)]
}

/** `rows` whose rows from `ordinal` on received new, later ts, as `recoverUiMessages` renews them. */
function renewFrom(rows: readonly UiMessage[], ordinal: number): UiMessage[] {
    const after = (rows.at(-1) as UiMessage).ts + 1_000
    return rows.map((entry, index) => (index < ordinal ? entry : { ...entry, ts: after + index * 10 }))
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

async function storedTurns(store: TrajectoryRowStore) {
    return (await store.readSnapshot(-1)).turns.map(({ revision: _revision, ...turn }) => turn)
}

describe("TrajectoryMaintainer", () => {
    let documentsRoot: string
    let writer: UiMessageRowStore
    let committed: CommittedUiMessages
    let store: TrajectoryRowStore
    let maintainer: TrajectoryMaintainer
    let rowReads: number[]

    beforeEach(async () => {
        nextTs = 1_000
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-maintainer-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        const { root } = await ensureInstanceLayout({ taskId: "task-maintained" })
        writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
        const reader = await UIMessage.openCommittedUiMessages("task-maintained")
        rowReads = []
        committed = {
            ...reader,
            rows: {
                readRange: async (start, end) => {
                    const rows = await reader.rows.readRange(start, end)
                    rowReads.push(rows.length)
                    return rows
                },
            },
        }
        store = await openTrajectoryRows(root)
        maintainer = new TrajectoryMaintainer({
            instanceId: "task-maintained",
            messages: committed,
            openStore: async () => store,
        })
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await maintainer.close()
        await committed.close()
        await writer.close().catch(() => undefined)
        await closeInstanceStoragesUnder(documentsRoot)
        vi.unstubAllEnvs()
        await rm(documentsRoot, { recursive: true, force: true })
    })

    it("builds turns anchored at each prompt and equal to a full fold", async () => {
        const history = [task("first"), tool(), tool(), user("second"), tool(), user("third")]
        await writer.replaceAll(records(history))

        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        const turns = await storedTurns(store)
        expect(turns.map((turn) => [turn.anchorOrdinal, turn.prompt])).toEqual([
            [0, "first"],
            [3, "second"],
            [5, "third"],
        ])
        expect(turns).toEqual(fullFold(history))
    })

    it("applies an append by refolding only the last turn", async () => {
        const history = [task("first"), tool(), user("second"), tool()]
        await writer.replaceAll(records(history))
        await maintainer.catchUp(WRITABLE)
        const before = (await store.readSnapshot(-1)).turns

        rowReads = []
        const appended = [tool(), user("third")]
        await writer.insert(appended.map((entry, index) => ({ ordinal: history.length + index, ts: entry.ts, message: entry })))
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        // Turn 1 is anchored at ordinal 2, so rows 2..5 are read and turn 0 is untouched.
        expect(rowReads).toEqual([4])
        const after = (await store.readSnapshot(-1)).turns
        expect(after[0]).toEqual(before[0])
        expect(await storedTurns(store)).toEqual(fullFold([...history, ...appended]))
    })

    it("folds an over-long turn in bounded slices", async () => {
        const history = [task("long"), ...Array.from({ length: TRAJECTORY_SLICE_ROWS + 20 }, () => tool())]
        await writer.replaceAll(records(history))

        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        expect(Math.max(...rowReads)).toBeLessThanOrEqual(TRAJECTORY_SLICE_ROWS)
        expect(rowReads.reduce((sum, count) => sum + count, 0)).toBe(history.length)
        expect(await storedTurns(store)).toEqual(fullFold(history))
    })

    it("merges the rows of a removed non-initial anchor into the turn before it", async () => {
        const history = [task("first"), tool(), user("second"), tool(), tool(), user("third"), tool()]
        await writer.replaceAll(records(history))
        await maintainer.catchUp(WRITABLE)

        const withoutSecond = history.filter((_, ordinal) => ordinal !== 2)
        await writer.replaceAll(records(withoutSecond), { firstChangedIndex: 2 })
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        const turns = await storedTurns(store)
        expect(turns.map((turn) => [turn.anchorOrdinal, turn.prompt])).toEqual([
            [0, "first"],
            [4, "third"],
        ])
        expect(turns).toEqual(fullFold(withoutSecond))
    })

    it("follows checkpoint truncation back to an earlier turn", async () => {
        const history = [task("first"), tool(), user("second"), tool(), user("third"), tool()]
        await writer.replaceAll(records(history))
        await maintainer.catchUp(WRITABLE)

        await writer.replaceAll(records(history.slice(0, 3)), { firstChangedIndex: 3 })
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        expect((await store.readSnapshot(-1)).meta?.turnCount).toBe(2)
        expect(await storedTurns(store)).toEqual(fullFold(history.slice(0, 3)))
    })

    it("persists an error for a logged ts violation and stops projecting", async () => {
        vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        const history = [task("first"), user("second")]
        await writer.replaceAll(records(history))
        await maintainer.catchUp(WRITABLE)

        const stale = { ...user("late"), ts: history[1].ts }
        await writer.insert([{ ordinal: 2, ts: stale.ts, message: stale }])

        expect(await maintainer.catchUp(WRITABLE)).toBe("error")
        expect((await store.readSnapshot(-1)).meta).toMatchObject({ state: "error", errorTs: stale.ts })
        expect(await maintainer.catchUp(WRITABLE)).toBe("error")
    })

    it("writes nothing and opens no store without write access", async () => {
        await writer.replaceAll(records([task("first")]))
        const opened = vi.fn(async () => store)
        const readOnly = new TrajectoryMaintainer({ instanceId: "task-maintained", messages: committed, openStore: opened })

        expect(await readOnly.catchUp({ writable: () => false })).toBe("not_writable")
        expect(opened).not.toHaveBeenCalled()
        expect(await store.readMeta()).toBeNull()
    })

    describe("rewrites of committed rows", () => {
        async function rewrite(rows: UiMessage[], firstChangedIndex: number): Promise<UiMessage[]> {
            await writer.replaceAll(records(rows), { firstChangedIndex })
            return rows
        }

        async function takeOverLastRow(rows: UiMessage[]): Promise<UiMessage[]> {
            const last = rows.at(-1) as UiMessage
            const takeover = { ts: last.ts, type: "ask", ask: "completion_result", text: "done" } as UiMessage
            const replaced = await writer.replaceTail({
                durableCount: rows.length,
                expectedTailTimestamps: [last.ts],
                replacedCount: 1,
                entries: [takeover],
            })
            expect(replaced).toBe(true)
            return [...rows.slice(0, -1), takeover]
        }

        const rewrites: [string, (base: UiMessage[]) => Promise<UiMessage[]>, number[]][] = [
            ["a delayed checkpoint placed in the first turn", (base) => rewrite(insertAt(base, 1, checkpoint()), 1), [0, 4, 7]],
            [
                "a chat-only checkpoint retired from the second turn",
                (base) =>
                    rewrite(
                        base.filter((_, ordinal) => ordinal !== 5),
                        5,
                    ),
                [0, 3, 5],
            ],
            [
                "a compaction card landing in the second turn",
                (base) => rewrite(insertAt(base, 5, compactionCard()), 5),
                [0, 3, 7],
            ],
            ["recoverUiMessages renewing the ts of the last turn", (base) => rewrite(renewFrom(base, 6), 6), [0, 3, 6]],
            ["a same-ts takeover of the last row", takeOverLastRow, [0, 3, 6]],
        ]

        it.each(rewrites)("matches the full fold after %s", async (_name, apply, anchors) => {
            const base = [task("first"), tool(), checkpoint(), user("second"), tool(), checkpoint(), user("third"), tool()]
            await writer.replaceAll(records(base))
            await maintainer.catchUp(WRITABLE)

            const final = await apply(base)
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

            const turns = await storedTurns(store)
            expect(turns.map((turn) => turn.anchorOrdinal)).toEqual(anchors)
            expect(turns.map((turn) => turn.anchorTs)).toEqual(anchors.map((ordinal) => final[ordinal].ts))
            expect(turns).toEqual(fullFold(final))
        })

        it("leaves the taken-over ask as the tail of the last turn", async () => {
            const base = [task("first"), tool(), user("second"), tool()]
            await writer.replaceAll(records(base))
            await maintainer.catchUp(WRITABLE)

            await takeOverLastRow(base)
            await maintainer.catchUp(WRITABLE)

            expect((await storedTurns(store)).at(-1)).toMatchObject({ tailTs: base[3].ts, tailAskKind: "completion_result" })
        })
    })

    describe("ts uniqueness", () => {
        it("persists an error from the sticky violation ts after its log entry was trimmed", async () => {
            vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
            const history = [task("first"), user("second")]
            await writer.replaceAll(records(history))
            const stale = { ...user("late"), ts: history[1].ts }
            await writer.insert([{ ordinal: 2, ts: stale.ts, message: stale }])
            expect((await committed.log.head()).violationTs).toBe(stale.ts)
            // Retention trimmed the entry that recorded the violation; only the sticky head field remains.
            const trimmed: CommittedUiMessages = {
                ...committed,
                log: { ...committed.log, since: async (seq) => ({ ...(await committed.log.since(seq)), tsViolation: null }) },
            }
            const projecting = new TrajectoryMaintainer({
                instanceId: "task-maintained",
                messages: trimmed,
                openStore: async () => store,
            })

            expect(await projecting.catchUp(WRITABLE)).toBe("error")
            expect(await store.readMeta()).toMatchObject({ state: "error", errorTs: stale.ts })
        })

        it("persists an error for a non-increasing ts the log never saw, found against the carry of the previous slice", async () => {
            vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
            const history = [task("long"), ...Array.from({ length: TRAJECTORY_SLICE_ROWS + 9 }, () => tool())]
            const duplicate = { ...history[TRAJECTORY_SLICE_ROWS], ts: history[TRAJECTORY_SLICE_ROWS - 1].ts }
            history[TRAJECTORY_SLICE_ROWS] = duplicate
            await writer.replaceAll(records(history))
            // Rows written before the commit log existed carry no log evidence.
            const unlogged: CommittedUiMessages = {
                ...committed,
                log: {
                    head: async () => ({ ...(await committed.log.head()), violationTs: null }),
                    since: async (seq) => ({ ...(await committed.log.since(seq)), violationTs: null, tsViolation: null }),
                },
            }
            const scanning = new TrajectoryMaintainer({
                instanceId: "task-maintained",
                messages: unlogged,
                openStore: async () => store,
            })

            expect(await scanning.catchUp(WRITABLE)).toBe("error")
            expect(rowReads).toEqual([TRAJECTORY_SLICE_ROWS, 10])
            expect(await store.readMeta()).toMatchObject({ state: "error", errorTs: duplicate.ts })
        })

        it("diagnoses a persisted duplicate ts in UIMessage.open before the dedupe repair hides it", async () => {
            const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
            const first = task("first")
            await writer.replaceAll(records([first, { ...user("second"), ts: first.ts }, tool()]))
            await writer.close()

            const opened = await UIMessage.open("task-maintained")
            try {
                expect(warn).toHaveBeenCalledWith(
                    "[messages.db] UiMessagePersistedDuplicateTs: task=task-maintained duplicates=1",
                )
                const timestamps = opened.getAll().map((entry) => entry.ts)
                expect(new Set(timestamps).size).toBe(timestamps.length)
            } finally {
                await opened.close()
            }
        })
    })
})
