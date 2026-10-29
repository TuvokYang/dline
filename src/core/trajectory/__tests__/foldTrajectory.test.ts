import { dropSupersededAdjacentCheckpoints } from "@shared/chat/checkpointAdjacency"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    carryAfterTurn,
    closeOpenTurn,
    EMPTY_FOLD_CARRY,
    type FoldedTurn,
    foldTrajectory,
    type OrdinalRow,
} from "../foldTrajectory"
import { ProducerRows } from "./fixtures/producerRows"

function ordinals(rows: readonly UiMessage[]): OrdinalRow[] {
    return rows.map((message, ordinal) => ({ ordinal, message }))
}

function foldAll(rows: readonly OrdinalRow[]): FoldedTurn[] {
    const result = foldTrajectory(rows, EMPTY_FOLD_CARRY)
    const last = closeOpenTurn(result.carry)
    return last ? [...result.turns, last] : [...result.turns]
}

function foldInSlices(rows: readonly OrdinalRow[], cuts: readonly number[]): FoldedTurn[] {
    const turns: FoldedTurn[] = []
    let carry = EMPTY_FOLD_CARRY
    let start = 0
    for (const end of [...cuts, rows.length]) {
        const result = foldTrajectory(rows.slice(start, end), carry)
        turns.push(...result.turns)
        carry = result.carry
        start = end
    }
    const last = closeOpenTurn(carry)
    return last ? [...turns, last] : turns
}

async function representativeHistory(): Promise<UiMessage[]> {
    const p = new ProducerRows()
    p.task("build the parser")
    p.checkpoint()
    p.apiRequest()
    p.tool("readFile")
    p.tool("readFile")
    p.ask("followup", JSON.stringify({ question: "which format?" }))
    await p.toolReply("json") // tool reply, same turn
    p.apiRequest()
    p.ask("command", "npm test")
    p.say("command_output", "ok")
    p.refusedCompletion() // does not end the attempt
    p.directInput("also handle errors") // turn 1, same attempt
    p.apiRequest()
    p.tool("editedExistingFile")
    p.say("hook_status", "{}")
    p.acceptedCompletion("done")
    p.checkpoint()
    await p.toolReply("now add docs") // after an accepted completion: turn 2, new attempt
    p.apiRequest()
    p.compactionCard()
    p.say("error_retry", "{}")
    p.apiRequest()
    p.queuedBatch(["first", "second"]) // turn 3, one row one turn
    p.apiRequest()
    return p.rows
}

describe("foldTrajectory", () => {
    it("folds a producer-shaped history into independently expected turns", async () => {
        const turns = foldAll(ordinals(await representativeHistory()))
        expect(
            turns.map(({ seq, attemptSeq, anchorOrdinal, rounds, toolUsage, endsAttempt }) => ({
                seq,
                attemptSeq,
                anchorOrdinal,
                rounds,
                toolUsage,
                endsAttempt,
            })),
        ).toEqual([
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                rounds: 2,
                toolUsage: [
                    { tool: "readFile", count: 2 },
                    { tool: "ask_followup_question", count: 1 },
                    { tool: "execute_command", count: 1 },
                ],
                endsAttempt: false,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 11,
                rounds: 1,
                toolUsage: [{ tool: "editedExistingFile", count: 1 }],
                endsAttempt: true,
            },
            { seq: 2, attemptSeq: 1, anchorOrdinal: 17, rounds: 2, toolUsage: [], endsAttempt: false },
            { seq: 3, attemptSeq: 1, anchorOrdinal: 22, rounds: 1, toolUsage: [], endsAttempt: false },
        ])
        expect(turns[0].prompt).toBe("build the parser")
    })

    it("yields the full-fold turns for every split point, including between an ask and its reply", async () => {
        const rows = ordinals(await representativeHistory())
        const expected = foldAll(rows)
        for (let cut = 0; cut <= rows.length; cut++) {
            expect(foldInSlices(rows, [cut])).toEqual(expected)
        }
        expect(foldInSlices(rows, [1, 2, 3, 5, 6, 7, 11, 12, 17, 18, 22])).toEqual(expected)
    })

    it("keeps a dialog reply in its turn when the compaction card lands between them, at every split point", async () => {
        const p = new ProducerRows()
        p.task("migrate the schema") // 0
        p.apiRequest() // 1
        p.ask("followup", JSON.stringify({ question: "drop the old column?" })) // 2
        p.compactionCard() // 3: summarizing the context answers nothing
        await p.toolReply("yes") // 4: still the reply to the followup
        p.apiRequest() // 5
        p.tool("readFile") // 6: a generic tool row is not ignored
        await p.toolReply("and the index") // 7: follows a say row, so a new instruction
        const rows = ordinals(p.rows)
        const expected = [
            {
                seq: 0,
                anchorOrdinal: 0,
                rounds: 2,
                toolUsage: [
                    { tool: "ask_followup_question", count: 1 },
                    { tool: "readFile", count: 1 },
                ],
            },
            { seq: 1, anchorOrdinal: 7, rounds: 0, toolUsage: [] },
        ]
        const shape = (turns: FoldedTurn[]) =>
            turns.map(({ seq, anchorOrdinal, rounds, toolUsage }) => ({ seq, anchorOrdinal, rounds, toolUsage }))

        expect(shape(foldAll(rows))).toEqual(expected)
        for (let cut = 0; cut <= rows.length; cut++) {
            expect(shape(foldInSlices(rows, [cut]))).toEqual(expected)
        }
    })

    it("resumes from the carry derived from a stored turn", async () => {
        const rows = ordinals(await representativeHistory())
        const expected = foldAll(rows)
        const resumeAt = expected[2]
        const result = foldTrajectory(rows.slice(resumeAt.anchorOrdinal), carryAfterTurn(expected[1]))
        const last = closeOpenTurn(result.carry)
        expect([...result.turns, ...(last ? [last] : [])]).toEqual(expected.slice(2))
    })

    it("folds a turn longer than 500 rows identically in 500-row slices", () => {
        const p = new ProducerRows()
        p.task("long job")
        for (let i = 0; i < 700; i++) {
            p.apiRequest()
            if (i % 7 === 0) p.tool("searchFiles")
        }
        p.directInput("second")
        const rows = ordinals(p.rows)
        const cuts = [500, 1000]
        const turns = foldInSlices(rows, cuts)
        expect(turns).toEqual(foldAll(rows))
        expect(turns[0].rounds).toBe(700)
        expect(turns[0].toolUsage).toEqual([{ tool: "searchFiles", count: 100 }])
        expect(turns[1].anchorOrdinal).toBe(rows.length - 1)
    })

    it("skips partial rows for aggregation while keeping physical ordinals", () => {
        const p = new ProducerRows()
        p.task("t")
        p.rows.push({ ...p.apiRequest(), partial: true })
        p.rows.splice(1, 1)
        p.tool("readFile")
        p.rows[p.rows.length - 1] = { ...p.rows[p.rows.length - 1], partial: true }
        p.directInput("next")
        const turns = foldAll(ordinals(p.rows))
        expect(turns[0]).toMatchObject({ rounds: 0, toolUsage: [] })
        expect(turns[1].anchorOrdinal).toBe(3)
    })

    it("reports a non-increasing ts inside a range and against carry.lastTs at a boundary", () => {
        const p = new ProducerRows()
        p.task("t")
        p.apiRequest()
        const duplicate = { ...p.apiRequest(), ts: p.rows[1].ts }
        p.rows[2] = duplicate
        const inside = foldTrajectory(ordinals(p.rows), EMPTY_FOLD_CARRY)
        expect(inside.provisionalViolation).toEqual({ ordinal: 2, ts: duplicate.ts, previousTs: duplicate.ts })

        const head = foldTrajectory(ordinals(p.rows).slice(0, 2), EMPTY_FOLD_CARRY)
        const boundary = foldTrajectory([{ ordinal: 2, message: { ...duplicate, ts: duplicate.ts - 5 } }], head.carry)
        expect(boundary.provisionalViolation?.ordinal).toBe(2)

        const clean = foldTrajectory(ordinals(p.rows).slice(0, 2), EMPTY_FOLD_CARRY)
        expect(clean.provisionalViolation).toBeNull()
    })

    it("is unaffected by checkpoint rows the display merges away", () => {
        const p = new ProducerRows()
        p.task("t")
        p.checkpoint()
        p.checkpoint()
        p.apiRequest()
        p.tool("readFile")
        p.checkpoint()
        p.checkpoint("h1")
        p.directInput("next")
        p.apiRequest()
        const withMerged = foldAll(ordinals(p.rows)).map(({ rounds, toolUsage, endsAttempt, attemptSeq }) => ({
            rounds,
            toolUsage,
            endsAttempt,
            attemptSeq,
        }))
        const displayed = dropSupersededAdjacentCheckpoints(p.rows)
        expect(displayed.length).toBeLessThan(p.rows.length)
        const withoutMerged = foldAll(ordinals(displayed)).map(({ rounds, toolUsage, endsAttempt, attemptSeq }) => ({
            rounds,
            toolUsage,
            endsAttempt,
            attemptSeq,
        }))
        expect(withoutMerged).toEqual(withMerged)
    })
})
