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
import type { TrajectoryRowStore, TrajectoryTurnInput } from "../../storage/trajectory/TrajectoryRowStore"
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
const round = () => message({ say: "api_req_started", text: "{}" })
const completed = () => message({ type: "ask", ask: "completion_result", text: "done" })
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

/** Independent interval view: a full fold is only a second consistency check. */
function intervals(turns: readonly TrajectoryTurnInput[]) {
    return turns.map(({ seq, anchorOrdinal, attemptSeq, rounds, toolUsage, endsAttempt }) => ({
        seq,
        anchorOrdinal,
        attemptSeq,
        rounds,
        tools: toolUsage.reduce((sum, usage) => sum + usage.count, 0),
        endsAttempt,
    }))
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
    let rowRanges: [number, number][]

    beforeEach(async () => {
        nextTs = 1_000
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-maintainer-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        const { root } = await ensureInstanceLayout({ taskId: "task-maintained" })
        writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
        const reader = await UIMessage.openCommittedUiMessages("task-maintained")
        rowReads = []
        rowRanges = []
        committed = {
            ...reader,
            rows: {
                readRange: async (start, end) => {
                    rowRanges.push([start, end])
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
        vi.useRealTimers()
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
        expect(intervals(turns)).toEqual([
            { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 0, tools: 2, endsAttempt: false },
            { seq: 1, anchorOrdinal: 3, attemptSeq: 0, rounds: 0, tools: 1, endsAttempt: false },
            { seq: 2, anchorOrdinal: 5, attemptSeq: 0, rounds: 0, tools: 0, endsAttempt: false },
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
        expect(rowRanges.at(-1)).toEqual([2, 2 + TRAJECTORY_SLICE_ROWS])
        expect(intervals(after)).toEqual([
            { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 0, tools: 1, endsAttempt: false },
            { seq: 1, anchorOrdinal: 2, attemptSeq: 0, rounds: 0, tools: 2, endsAttempt: false },
            { seq: 2, anchorOrdinal: 5, attemptSeq: 0, rounds: 0, tools: 0, endsAttempt: false },
        ])
        expect(await storedTurns(store)).toEqual(fullFold([...history, ...appended]))
    })

    it("folds an over-long turn in bounded slices", async () => {
        const history = [task("long"), ...Array.from({ length: TRAJECTORY_SLICE_ROWS + 20 }, () => tool())]
        await writer.replaceAll(records(history))

        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        expect(Math.max(...rowReads)).toBeLessThanOrEqual(TRAJECTORY_SLICE_ROWS)
        expect(rowReads.reduce((sum, count) => sum + count, 0)).toBe(history.length)
        expect(rowRanges.every(([start, end]) => end - start === TRAJECTORY_SLICE_ROWS)).toBe(true)
        expect(intervals(await storedTurns(store))).toEqual([
            { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 0, tools: TRAJECTORY_SLICE_ROWS + 20, endsAttempt: false },
        ])
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
        expect(intervals(turns)).toEqual([
            { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 0, tools: 3, endsAttempt: false },
            { seq: 1, anchorOrdinal: 4, attemptSeq: 0, rounds: 0, tools: 1, endsAttempt: false },
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

    it.each(["equal", "decreasing"])("retains every user interval and count with %s ts", async (order) => {
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        const history = [task("first"), round(), tool(), completed(), user("second"), tool(), round(), user("third"), tool()].map(
            (entry, ordinal) => ({ ...entry, ts: order === "equal" ? 40 : 100 - ordinal }),
        )
        await writer.replaceAll(records(history))
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
        const appended = [
            { ...user("fourth"), ts: 40 },
            { ...round(), ts: 39 },
            { ...tool(), ts: 38 },
        ]
        await writer.insert(records([...history, ...appended]).slice(history.length))
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        const turns = await storedTurns(store)
        expect(intervals(turns)).toEqual([
            { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 1, tools: 1, endsAttempt: true },
            { seq: 1, anchorOrdinal: 4, attemptSeq: 1, rounds: 1, tools: 1, endsAttempt: false },
            { seq: 2, anchorOrdinal: 7, attemptSeq: 1, rounds: 0, tools: 1, endsAttempt: false },
            { seq: 3, anchorOrdinal: 9, attemptSeq: 1, rounds: 1, tools: 1, endsAttempt: false },
        ])
        expect(turns.map(({ prompt }) => prompt)).toEqual(["first", "second", "third", "fourth"])
        expect(turns).toEqual(fullFold([...history, ...appended]))
        expect(warn.mock.calls.filter(([message]) => String(message).startsWith("[trajectory]"))).toEqual([])
    })

    it("reclassifies an anchor from the interval containing x-1, preserving the earlier prefix", async () => {
        const history = [task("first"), tool(), user("second"), round(), user("removed"), tool(), user("last"), tool()]
        await writer.replaceAll(records(history))
        await maintainer.catchUp(WRITABLE)
        const before = (await store.readSnapshot(-1)).turns
        const changed = history.map((entry, ordinal) => (ordinal === 4 ? { ...tool(), ts: entry.ts } : entry))
        await writer.replaceAll(records(changed), { firstChangedIndex: 4 })
        rowRanges = []

        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")

        const after = (await store.readSnapshot(-1)).turns
        expect(rowRanges).toEqual([[2, 2 + TRAJECTORY_SLICE_ROWS]])
        expect(after[0]).toEqual(before[0])
        expect(intervals(after)).toEqual([
            { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 0, tools: 1, endsAttempt: false },
            { seq: 1, anchorOrdinal: 2, attemptSeq: 0, rounds: 1, tools: 2, endsAttempt: false },
            { seq: 2, anchorOrdinal: 6, attemptSeq: 0, rounds: 0, tools: 1, endsAttempt: false },
        ])
        expect(await storedTurns(store)).toEqual(fullFold(changed))
    })

    it("preserves classification before the first anchor when a leading ask is replaced", async () => {
        const history = [message({ type: "ask", ask: "followup" }), user("reply"), checkpoint(), user("instruction")]
        await writer.replaceAll(records(history))
        await maintainer.catchUp(WRITABLE)
        expect((await storedTurns(store)).map((turn) => turn.anchorOrdinal)).toEqual([3])
        const changed = [{ ...history[0], ask: "completion_result" } as UiMessage, ...history.slice(1)]
        await writer.replaceAll(records(changed), { firstChangedIndex: 0 })
        rowRanges = []
        expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
        expect(rowRanges[0][0]).toBe(0)
        expect((await storedTurns(store)).map((turn) => [turn.anchorOrdinal, turn.prompt])).toEqual([
            [1, "reply"],
            [3, "instruction"],
        ])
        expect(await storedTurns(store)).toEqual(fullFold(changed))
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
            expect(turns.map((turn) => [turn.attemptSeq, turn.rounds, turn.toolUsage, turn.endsAttempt])).toEqual([
                [0, 0, [{ tool: "readFile", count: 1 }], false],
                [0, 0, [{ tool: "readFile", count: 1 }], false],
                [
                    0,
                    0,
                    _name === "a same-ts takeover of the last row" ? [] : [{ tool: "readFile", count: 1 }],
                    _name === "a same-ts takeover of the last row",
                ],
            ])
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

    describe("committed-only C3 port", () => {
        it.each(["absent", "null", "value", "trapped"])("ignores %s storage-only diagnostic fields", async (diagnostics) => {
            const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
            const accessed = vi.fn(() => {
                throw new Error("Storage diagnostics are not trajectory inputs")
            })
            const decorate = <T extends object>(value: T): T => {
                if (diagnostics === "absent") return value
                for (const key of ["violationTs", "tsViolation"]) {
                    Object.defineProperty(value, key, {
                        enumerable: true,
                        ...(diagnostics === "trapped" ? { get: accessed } : { value: diagnostics === "null" ? null : 40 }),
                    })
                }
                return value
            }
            const messages: CommittedUiMessages = {
                ...committed,
                log: {
                    head: async () => {
                        const { logId, headSeq } = await committed.log.head()
                        return decorate({ logId, headSeq })
                    },
                    since: async (seq) => {
                        const { logId, headSeq, minFirstChangedOrdinal } = await committed.log.since(seq)
                        return decorate({ logId, headSeq, minFirstChangedOrdinal })
                    },
                },
            }
            const clear = vi.spyOn(store, "clear")
            const replace = vi.spyOn(store, "replaceFrom")
            const update = vi.spyOn(store, "updateMeta")
            const projecting = new TrajectoryMaintainer({ instanceId: "task-maintained", messages, openStore: async () => store })
            const history = [task("first"), round(), tool(), user("second"), tool()].map((entry) => ({ ...entry, ts: 40 }))
            await writer.replaceAll(records(history))
            try {
                expect(await projecting.catchUp(WRITABLE)).toBe("ready")
                const appended = [user("third"), round(), tool()].map((entry) => ({ ...entry, ts: 39 }))
                await writer.insert(records([...history, ...appended]).slice(history.length))
                expect(await projecting.catchUp(WRITABLE)).toBe("ready")
                expect(intervals(await storedTurns(store))).toEqual([
                    { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 1, tools: 1, endsAttempt: false },
                    { seq: 1, anchorOrdinal: 3, attemptSeq: 0, rounds: 0, tools: 1, endsAttempt: false },
                    { seq: 2, anchorOrdinal: 5, attemptSeq: 0, rounds: 1, tools: 1, endsAttempt: false },
                ])
                expect(rowReads).toEqual([5, 5])
                expect(clear).toHaveBeenCalledTimes(1)
                expect(replace.mock.calls.map(([fromSeq]) => fromSeq)).toEqual([0, 1])
                expect(update).not.toHaveBeenCalled()
                expect(accessed).not.toHaveBeenCalled()
                expect(warn.mock.calls.filter(([message]) => String(message).startsWith("[trajectory]"))).toEqual([])
            } finally {
                await projecting.close()
            }
        })

        it("keeps every anchor and count across a slice boundary with equal ts", async () => {
            const history = [task("long"), ...Array.from({ length: TRAJECTORY_SLICE_ROWS + 9 }, () => tool())].map(
                (entry, ordinal) => ({
                    ...entry,
                    ts: 40,
                    ...(ordinal === TRAJECTORY_SLICE_ROWS ? { say: "user_feedback" as const, text: "next" } : {}),
                }),
            )
            await writer.replaceAll(records(history))
            expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
            expect(rowReads).toEqual([TRAJECTORY_SLICE_ROWS, 10])
            expect(intervals(await storedTurns(store))).toEqual([
                { seq: 0, anchorOrdinal: 0, attemptSeq: 0, rounds: 0, tools: 499, endsAttempt: false },
                { seq: 1, anchorOrdinal: 500, attemptSeq: 0, rounds: 0, tools: 9, endsAttempt: false },
            ])
            expect(await storedTurns(store)).toEqual(fullFold(history))
        })

        it("reads durable rows rather than a writer's staged rewrite, and signals carry no data", async () => {
            const history = [task("first"), tool()]
            await writer.replaceAll(records(history))
            await writer.close()
            // Keep the periodic flush from racing this committed/staged comparison.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
            const live = await UIMessage.open("task-maintained")
            const signal = vi.fn()
            const unsubscribe = committed.signals.subscribe(signal)
            try {
                await maintainer.catchUp(WRITABLE)
                const head = await committed.log.head()
                await live.updateMessage(1, { say: "user_feedback", text: "staged" })
                expect(live.getAt(1)?.say).toBe("user_feedback")
                expect((await committed.rows.readRange(1, 2))[0].message.say).toBe("tool")
                expect(await committed.log.head()).toEqual(head)
                expect(signal).not.toHaveBeenCalled()
                await maintainer.catchUp(WRITABLE)
                expect((await storedTurns(store)).map((turn) => turn.anchorOrdinal)).toEqual([0])
                await live.flush()
                expect(signal).toHaveBeenCalledWith()
                expect(await maintainer.catchUp(WRITABLE)).toBe("ready")
                expect((await storedTurns(store)).map((turn) => [turn.anchorOrdinal, turn.prompt])).toEqual([
                    [0, "first"],
                    [1, "staged"],
                ])
            } finally {
                unsubscribe()
                await live.close()
                vi.useRealTimers()
            }
        })
    })
})
