import { dropSupersededAdjacentCheckpoints } from "@shared/chat/checkpointAdjacency"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    carryAfterTurn,
    closeOpenTurn,
    EMPTY_FOLD_CARRY,
    type FoldCarry,
    type FoldedTurn,
    foldTrajectory,
    type OrdinalRow,
} from "../foldTrajectory"
import { ProducerRows, TIMESTAMP_PATTERNS, withTimestampPattern } from "./fixtures/producerRows"

/** Business expectations are written independently; identity payloads come from their own source rows. */
type ExpectedTurn = Omit<FoldedTurn, "anchorTs" | "tailTs"> & { readonly tailOrdinal: number }

function ordinals(rows: readonly UiMessage[]): OrdinalRow[] {
    return rows.map((message, ordinal) => ({ ordinal, message }))
}

function withIdentities(rows: readonly OrdinalRow[], expected: readonly ExpectedTurn[]): FoldedTurn[] {
    return expected.map(({ tailOrdinal, ...turn }) => ({
        ...turn,
        anchorTs: rows[turn.anchorOrdinal].message.ts,
        tailTs: rows[tailOrdinal].message.ts,
    }))
}

function foldAll(rows: readonly OrdinalRow[], carry: FoldCarry = EMPTY_FOLD_CARRY): FoldedTurn[] {
    const result = foldTrajectory(rows, carry)
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

function expectEverySplit(rows: readonly OrdinalRow[], expected: readonly FoldedTurn[]): void {
    const whole = foldAll(rows)
    expect(whole).toEqual(expected)
    for (let cut = 0; cut <= rows.length; cut++) {
        const sliced = foldInSlices(rows, [cut])
        expect(sliced, `independent oracle at split ${cut}`).toEqual(expected)
        expect(sliced, `unsliced equivalence at split ${cut}`).toEqual(whole)
    }
}

async function representativeHistory(): Promise<UiMessage[]> {
    const p = new ProducerRows()
    p.task("build the parser") // 0
    p.checkpoint()
    p.apiRequest()
    p.tool("readFile")
    p.tool("readFile")
    p.ask("followup", JSON.stringify({ question: "which format?" }))
    await p.toolReply("json")
    p.apiRequest()
    p.ask("command", "npm test")
    p.say("command_output", "ok")
    p.refusedCompletion() // 10: does not end the attempt
    p.directInput("also handle errors") // 11: same attempt
    p.apiRequest()
    p.tool("editedExistingFile")
    p.say("hook_status", "{}")
    p.acceptedCompletion("done")
    p.checkpoint() // 16: tail identity advances, completion context remains
    await p.toolReply("now add docs") // 17: new attempt after accepted completion
    p.apiRequest()
    p.compactionCard()
    p.say("error_retry", "{}")
    p.apiRequest()
    p.queuedBatch(["first", "second"]) // 22: one row, one turn
    p.apiRequest() // 23
    return p.rows
}

const representativeExpected: readonly ExpectedTurn[] = [
    {
        seq: 0,
        attemptSeq: 0,
        anchorOrdinal: 0,
        prompt: "build the parser",
        rounds: 2,
        toolUsage: [
            { tool: "readFile", count: 2 },
            { tool: "ask_followup_question", count: 1 },
            { tool: "execute_command", count: 1 },
        ],
        endsAttempt: false,
        tailOrdinal: 10,
        tailAskKind: null,
    },
    {
        seq: 1,
        attemptSeq: 0,
        anchorOrdinal: 11,
        prompt: "also handle errors",
        rounds: 1,
        toolUsage: [{ tool: "editedExistingFile", count: 1 }],
        endsAttempt: true,
        tailOrdinal: 16,
        tailAskKind: "completion_result",
    },
    {
        seq: 2,
        attemptSeq: 1,
        anchorOrdinal: 17,
        prompt: "now add docs",
        rounds: 2,
        toolUsage: [],
        endsAttempt: false,
        tailOrdinal: 21,
        tailAskKind: null,
    },
    {
        seq: 3,
        attemptSeq: 1,
        anchorOrdinal: 22,
        prompt: "first\n\nsecond",
        rounds: 1,
        toolUsage: [],
        endsAttempt: false,
        tailOrdinal: 23,
        tailAskKind: null,
    },
]

describe("foldTrajectory ordinal intervals", () => {
    it.each(TIMESTAMP_PATTERNS)("matches the independent turn/attempt oracle with %s ts at every split", async (pattern) => {
        const rows = ordinals(withTimestampPattern(await representativeHistory(), pattern))
        const expected = withIdentities(rows, representativeExpected)
        expectEverySplit(rows, expected)
        expect(foldInSlices(rows, [0, 1, 2, 3, 5, 6, 6, 7, 11, 12, 17, 18, 22, 24, 24])).toEqual(expected)
    })

    it("retains all five anchors in the seven-row duplicate/backwards regression", () => {
        const rows = ordinals([
            { ts: 100, type: "say", say: "task", text: "first" },
            { ts: 300, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile" }) },
            { ts: 200, type: "say", say: "user_feedback", text: "retained" },
            { ts: 400, type: "say", say: "api_req_started", text: "{}" },
            { ts: 200, type: "say", say: "user_feedback", text: "duplicate" },
            { ts: 150, type: "say", say: "user_feedback", text: "backwards" },
            { ts: 500, type: "say", say: "user_feedback", text: "next" },
        ])
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                prompt: "first",
                rounds: 0,
                toolUsage: [{ tool: "readFile", count: 1 }],
                endsAttempt: false,
                tailOrdinal: 1,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 2,
                prompt: "retained",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 3,
                tailAskKind: null,
            },
            {
                seq: 2,
                attemptSeq: 0,
                anchorOrdinal: 4,
                prompt: "duplicate",
                rounds: 0,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 4,
                tailAskKind: null,
            },
            {
                seq: 3,
                attemptSeq: 0,
                anchorOrdinal: 5,
                prompt: "backwards",
                rounds: 0,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 5,
                tailAskKind: null,
            },
            {
                seq: 4,
                attemptSeq: 0,
                anchorOrdinal: 6,
                prompt: "next",
                rounds: 0,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 6,
                tailAskKind: null,
            },
        ])
        expectEverySplit(rows, expected)
        expect(foldInSlices(rows, [0, 2, 2, 4, 5, 6, 7])).toEqual(expected)
        expect(foldAll(rows.slice(4), carryAfterTurn(expected[1]))).toEqual(expected.slice(2))
    })

    it.each(TIMESTAMP_PATTERNS)("keeps distinct per-interval requests and tools with %s ts", (pattern) => {
        const p = new ProducerRows()
        p.task("first") // 0
        p.tool("readFile")
        p.directInput("second") // 2
        p.apiRequest()
        p.tool("editedExistingFile")
        p.tool("editedExistingFile")
        p.directInput("third") // 6
        p.apiRequest()
        p.apiRequest()
        p.tool("searchFiles")
        p.tool("statusUpdate")
        p.directInput("fourth") // 11
        p.apiRequest()
        p.apiRequest()
        p.apiRequest()
        p.ask("command", "npm test")
        p.say("command_output", "ok")
        p.directInput("fifth") // 17
        p.apiRequest()
        p.apiRequest()
        p.apiRequest()
        p.apiRequest()
        p.ask("use_mcp_server", "{}")
        p.ask("use_mcp_server", "{}")
        p.acceptedCompletion() // 24
        const rows = ordinals(withTimestampPattern(p.rows, pattern))
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                prompt: "first",
                rounds: 0,
                toolUsage: [{ tool: "readFile", count: 1 }],
                endsAttempt: false,
                tailOrdinal: 1,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 2,
                prompt: "second",
                rounds: 1,
                toolUsage: [{ tool: "editedExistingFile", count: 2 }],
                endsAttempt: false,
                tailOrdinal: 5,
                tailAskKind: null,
            },
            {
                seq: 2,
                attemptSeq: 0,
                anchorOrdinal: 6,
                prompt: "third",
                rounds: 2,
                toolUsage: [
                    { tool: "searchFiles", count: 1 },
                    { tool: "phase_report", count: 1 },
                ],
                endsAttempt: false,
                tailOrdinal: 10,
                tailAskKind: null,
            },
            {
                seq: 3,
                attemptSeq: 0,
                anchorOrdinal: 11,
                prompt: "fourth",
                rounds: 3,
                toolUsage: [{ tool: "execute_command", count: 1 }],
                endsAttempt: false,
                tailOrdinal: 16,
                tailAskKind: null,
            },
            {
                seq: 4,
                attemptSeq: 0,
                anchorOrdinal: 17,
                prompt: "fifth",
                rounds: 4,
                toolUsage: [{ tool: "use_mcp_tool", count: 2 }],
                endsAttempt: true,
                tailOrdinal: 24,
                tailAskKind: "completion_result",
            },
        ])
        expectEverySplit(rows, expected)
        expect(foldInSlices(rows, [1, 2, 3, 6, 10, 11, 17, 18, 24])).toEqual(expected)
    })

    it("does not impose finite-value admission on opaque timestamp payloads", () => {
        const rows = ordinals([
            { ts: Number.NaN, type: "say", say: "task", text: "first" },
            { ts: Number.POSITIVE_INFINITY, type: "say", say: "tool", text: '{"tool":"readFile"}' },
            { ts: Number.NEGATIVE_INFINITY, type: "say", say: "user_feedback", text: "second" },
            { ts: Number.NaN, type: "say", say: "api_req_started" },
            { ts: Number.POSITIVE_INFINITY, type: "say", say: "user_feedback", text: "third" },
        ])
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                prompt: "first",
                rounds: 0,
                toolUsage: [{ tool: "readFile", count: 1 }],
                endsAttempt: false,
                tailOrdinal: 1,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 2,
                prompt: "second",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 3,
                tailAskKind: null,
            },
            {
                seq: 2,
                attemptSeq: 0,
                anchorOrdinal: 4,
                prompt: "third",
                rounds: 0,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 4,
                tailAskKind: null,
            },
        ])
        expectEverySplit(rows, expected)
    })

    it("uses supplied physical ordinals, not the slice offset or a timestamp sort", () => {
        const rows: OrdinalRow[] = [
            { ordinal: 73, message: { ts: 20, type: "say", say: "task", text: "first" } },
            { ordinal: 74, message: { ts: 10, type: "say", say: "api_req_started" } },
            { ordinal: 75, message: { ts: 10, type: "say", say: "user_feedback", text: "second" } },
        ]
        expectEverySplit(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 73,
                anchorTs: 20,
                prompt: "first",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailTs: 10,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 75,
                anchorTs: 10,
                prompt: "second",
                rounds: 0,
                toolUsage: [],
                endsAttempt: false,
                tailTs: 10,
                tailAskKind: null,
            },
        ])
    })
})

describe("foldTrajectory carry", () => {
    it.each(TIMESTAMP_PATTERNS)("resumes each stored-turn suffix without a timestamp cursor for %s ts", async (pattern) => {
        const rows = ordinals(withTimestampPattern(await representativeHistory(), pattern))
        const expected = withIdentities(rows, representativeExpected)
        for (let previousIndex = 0; previousIndex < expected.length - 1; previousIndex++) {
            const previous = expected[previousIndex]
            const carry = carryAfterTurn(previous)
            expect(carry).toEqual({
                seq: previousIndex + 1,
                attemptSeq: previous.attemptSeq,
                openTurn: null,
                prevCompleted: previous.endsAttempt,
                lastAskKind: previous.tailAskKind,
            })
            const suffix = rows.slice(expected[previousIndex + 1].anchorOrdinal)
            expect(foldAll(suffix, carry)).toEqual(expected.slice(previousIndex + 1))
            // Compatibility identities of a stored prefix cannot admit or reject its suffix.
            const differentPayload = { ...previous, anchorTs: Number.NaN, tailTs: Number.POSITIVE_INFINITY }
            expect(carryAfterTurn(differentPayload)).toEqual(carry)
            expect(foldAll(suffix, carryAfterTurn(differentPayload))).toEqual(expected.slice(previousIndex + 1))
        }
    })

    it("restores the stored ask context before an untagged reply across ignored rows", async () => {
        const previous: FoldedTurn = {
            seq: 3,
            attemptSeq: 2,
            anchorOrdinal: 20,
            anchorTs: 100,
            prompt: "previous",
            rounds: 1,
            toolUsage: [{ tool: "ask_followup_question", count: 1 }],
            endsAttempt: false,
            tailTs: 50,
            tailAskKind: "followup",
        }
        const p = new ProducerRows()
        p.compactionCard()
        await p.toolReply("answer to the stored ask")
        p.directInput("new instruction")
        p.apiRequest()
        const rows = withTimestampPattern(p.rows, "equal").map((message, index) => ({ ordinal: 30 + index, message }))
        const head = foldTrajectory(rows.slice(0, 1), carryAfterTurn(previous))
        expect(head.turns).toEqual([])
        expect(head.carry).toEqual({
            seq: 4,
            attemptSeq: 2,
            openTurn: null,
            prevCompleted: false,
            lastAskKind: "followup",
        })
        const answer = foldTrajectory(rows.slice(1, 2), head.carry)
        expect(answer.turns).toEqual([])
        expect(answer.carry.openTurn).toBeNull()
        expect(foldAll(rows.slice(2), answer.carry)).toEqual([
            {
                seq: 4,
                attemptSeq: 2,
                anchorOrdinal: 32,
                anchorTs: 1_000,
                prompt: "new instruction",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailTs: 1_000,
                tailAskKind: null,
            },
        ])
    })

    it.each(TIMESTAMP_PATTERNS)("keeps 499/500/501 anchors and a final 1200+ row turn for %s ts", (pattern) => {
        const p = new ProducerRows()
        p.task("before boundary")
        p.tool("readFile")
        while (p.rows.length < 499) p.apiRequest()
        p.directInput("at 499")
        p.queuedBatch(["at 500", "one batch"])
        p.directInput("long tail") // 501
        for (let i = 0; i < 1_100; i++) {
            p.apiRequest()
            if (i % 10 === 0) p.tool("searchFiles")
        }
        p.acceptedCompletion() // 1712
        p.apiRequest().partial = true // 1713: not a count or tail identity
        const rows = ordinals(withTimestampPattern(p.rows, pattern))
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                prompt: "before boundary",
                rounds: 497,
                toolUsage: [{ tool: "readFile", count: 1 }],
                endsAttempt: false,
                tailOrdinal: 498,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 499,
                prompt: "at 499",
                rounds: 0,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 499,
                tailAskKind: null,
            },
            {
                seq: 2,
                attemptSeq: 0,
                anchorOrdinal: 500,
                prompt: "at 500\n\none batch",
                rounds: 0,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 500,
                tailAskKind: null,
            },
            {
                seq: 3,
                attemptSeq: 0,
                anchorOrdinal: 501,
                prompt: "long tail",
                rounds: 1_100,
                toolUsage: [{ tool: "searchFiles", count: 110 }],
                endsAttempt: true,
                tailOrdinal: 1712,
                tailAskKind: "completion_result",
            },
        ])
        expectEverySplit(rows, expected)
        expect(foldInSlices(rows, [0, 499, 500, 501, 502, 1_000, 1_500, 1_714])).toEqual(expected)
        expect(foldInSlices(rows, [500, 1_000, 1_500])).toEqual(expected)

        // A persisted job resumes by value; no slice closes the still-open tail.
        const first = foldTrajectory(rows.slice(0, 500), EMPTY_FOLD_CARRY)
        expect(first.turns).toEqual(expected.slice(0, 1))
        expect(first.carry.openTurn?.anchorOrdinal).toBe(499)
        const second = foldTrajectory(rows.slice(500, 1_000), structuredClone(first.carry))
        expect(second.turns).toEqual(expected.slice(1, 3))
        const third = foldTrajectory(rows.slice(1_000, 1_500), structuredClone(second.carry))
        expect(third.turns).toEqual([])
        const last = foldTrajectory(rows.slice(1_500), structuredClone(third.carry))
        expect(last.turns).toEqual([])
        expect(closeOpenTurn(last.carry)).toEqual(expected[3])
    })

    it("returns no turns before an anchor, but keeps the context that classifies replies", async () => {
        const p = new ProducerRows()
        p.apiRequest() // not counted before the first user anchor
        p.tool("readFile")
        p.ask("followup", "question")
        p.compactionCard()
        await p.toolReply("answer") // not a new user instruction
        const prefix = foldTrajectory(ordinals(p.rows), EMPTY_FOLD_CARRY)
        expect(prefix.turns).toEqual([])
        expect(prefix.carry).toEqual({ seq: 0, attemptSeq: 0, openTurn: null, prevCompleted: false, lastAskKind: null })
        expect(closeOpenTurn(prefix.carry)).toBeNull()
        p.directInput("first instruction") // 5
        p.apiRequest()
        p.acceptedCompletion()
        p.directInput("next attempt") // 8
        p.apiRequest()
        const rows = ordinals(p.rows)
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 5,
                prompt: "first instruction",
                rounds: 1,
                toolUsage: [],
                endsAttempt: true,
                tailOrdinal: 7,
                tailAskKind: "completion_result",
            },
            {
                seq: 1,
                attemptSeq: 1,
                anchorOrdinal: 8,
                prompt: "next attempt",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 9,
                tailAskKind: null,
            },
        ])
        expectEverySplit(rows, expected)
        expect(foldAll(rows.slice(5), prefix.carry)).toEqual(expected)
    })

    it("keeps empty chunks and repeated closes pure without duplicating or mutating counts", () => {
        expect(foldTrajectory([], EMPTY_FOLD_CARRY)).toEqual({ turns: [], carry: EMPTY_FOLD_CARRY })
        expect(closeOpenTurn(EMPTY_FOLD_CARRY)).toBeNull()
        const p = new ProducerRows()
        p.task("first")
        p.apiRequest()
        p.tool("readFile")
        p.tool("readFile")
        p.directInput("second")
        p.apiRequest()
        const rows = ordinals(p.rows)
        const savedRows = structuredClone(rows)
        for (const row of rows) {
            Object.freeze(row.message)
            Object.freeze(row)
        }
        Object.freeze(rows)
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                prompt: "first",
                rounds: 1,
                toolUsage: [{ tool: "readFile", count: 2 }],
                endsAttempt: false,
                tailOrdinal: 3,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 4,
                prompt: "second",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 5,
                tailAskKind: null,
            },
        ])
        const head = foldTrajectory(rows.slice(0, 3), EMPTY_FOLD_CARRY)
        const savedCarry = structuredClone(head.carry)
        expect(head.turns).toEqual([])
        expect(head.carry).toEqual({
            seq: 1,
            attemptSeq: 0,
            prevCompleted: false,
            lastAskKind: null,
            openTurn: {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                anchorTs: rows[0].message.ts,
                prompt: "first",
                rounds: 1,
                toolUsage: [{ tool: "readFile", count: 1 }],
                endsAttempt: false,
                tailTs: rows[2].message.ts,
            },
        })
        if (head.carry.openTurn) {
            for (const count of head.carry.openTurn.toolUsage) Object.freeze(count)
            Object.freeze(head.carry.openTurn.toolUsage)
            Object.freeze(head.carry.openTurn)
        }
        Object.freeze(head.carry)
        const empty = foldTrajectory([], head.carry)
        expect(empty.turns).toEqual([])
        expect(empty.carry).toBe(head.carry)
        const tail = foldTrajectory(rows.slice(3), empty.carry)
        expect(tail.turns).toEqual(expected.slice(0, 1))
        expect(closeOpenTurn(tail.carry)).toEqual(expected[1])
        expect(closeOpenTurn(tail.carry)).toEqual(expected[1])
        expect(foldTrajectory([], tail.carry)).toEqual({ turns: [], carry: tail.carry })
        expect(head.carry).toEqual(savedCarry)
        expect(rows).toEqual(savedRows)
        expect(foldInSlices(rows, [0, 0, 3, 3, 4, 6, 6])).toEqual(expected)
    })
})

describe("foldTrajectory exclusions and previews", () => {
    it.each(
        TIMESTAMP_PATTERNS,
    )("keeps partial positions without starts, counts or context changes for %s ts", async (pattern) => {
        const p = new ProducerRows()
        p.task("partial task").partial = true // 0
        p.directInput("partial feedback").partial = true
        p.task("actual task") // 2
        p.task("another partial task").partial = true
        p.directInput("draft input").partial = true
        p.queuedBatch(["draft batch"]).partial = true
        p.apiRequest().partial = true
        p.tool("readFile").partial = true
        p.acceptedCompletion().partial = true
        p.say("completion_result", "draft result", { partial: true })
        p.apiRequest() // 10
        p.ask("followup", "question") // 11
        p.apiRequest().partial = true
        p.say("text", "draft text", { partial: true })
        p.acceptedCompletion().partial = true
        p.checkpoint()
        await p.toolReply("answer") // 16: partial rows did not clear the follow-up ask
        p.refusedCompletion()
        p.directInput("next") // 18: refused and partial completions did not end the attempt
        p.apiRequest() // 19: last final row
        p.acceptedCompletion().partial = true
        p.tool("searchFiles").partial = true
        const rows = ordinals(withTimestampPattern(p.rows, pattern))
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 2,
                prompt: "actual task",
                rounds: 1,
                toolUsage: [{ tool: "ask_followup_question", count: 1 }],
                endsAttempt: false,
                tailOrdinal: 17,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 18,
                prompt: "next",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 19,
                tailAskKind: null,
            },
        ])
        expectEverySplit(rows, expected)
        expect(foldInSlices(rows, [0, 2, 6, 11, 12, 14, 16, 18, 20, 22])).toEqual(expected)
    })

    it.each([
        ["followup", "ask_followup_question"],
        ["make_plan", "make_plan"],
        ["generate_report", "generate_report"],
        ["qna_respond", undefined],
    ] as const)("keeps an untagged %s reply in its turn across infrastructure rows", async (ask, tool) => {
        const p = new ProducerRows()
        p.task("migrate the schema") // 0
        p.apiRequest()
        p.ask(ask, "question") // 2
        p.checkpoint()
        p.say("hook_status", "{}")
        p.say("hook_output_stream", "hook log")
        p.say("info", "notice")
        p.say("task_progress", "{}")
        p.say("state_snapshot", "{}")
        p.say("conditional_rules_applied", "{}")
        p.say("subagent_usage", "{}")
        p.say("api_req_finished", "{}")
        p.say("api_req_retried", "{}")
        p.say("deleted_api_reqs", "{}")
        p.say("error_retry", "{}")
        p.compactionCard()
        await p.toolReply("yes") // 16: still the tool answer
        p.apiRequest()
        p.tool("readFile") // 18: meaningful say clears the ask context
        await p.toolReply("and the index") // 19: a new instruction
        p.apiRequest()
        const rows = ordinals(withTimestampPattern(p.rows, "equal"))
        const expected = withIdentities(rows, [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                prompt: "migrate the schema",
                rounds: 2,
                toolUsage: [...(tool ? [{ tool, count: 1 }] : []), { tool: "readFile", count: 1 }],
                endsAttempt: false,
                tailOrdinal: 18,
                tailAskKind: null,
            },
            {
                seq: 1,
                attemptSeq: 0,
                anchorOrdinal: 19,
                prompt: "and the index",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 20,
                tailAskKind: null,
            },
        ])
        expectEverySplit(rows, expected)
        expect(foldInSlices(rows, [3, 7, 12, 15, 16, 17, 19])).toEqual(expected)
    })

    it("keeps statistics and attempts when display-only superseded checkpoints are removed", () => {
        const p = new ProducerRows()
        p.task("t") // 0
        p.checkpoint()
        p.checkpoint()
        p.apiRequest()
        p.tool("readFile")
        p.acceptedCompletion()
        p.checkpoint()
        p.checkpoint("h1")
        p.directInput("next") // 8 in the committed source
        p.apiRequest()
        const source = ordinals(p.rows)
        const sourceExpected: readonly ExpectedTurn[] = [
            {
                seq: 0,
                attemptSeq: 0,
                anchorOrdinal: 0,
                prompt: "t",
                rounds: 1,
                toolUsage: [{ tool: "readFile", count: 1 }],
                endsAttempt: true,
                tailOrdinal: 7,
                tailAskKind: "completion_result",
            },
            {
                seq: 1,
                attemptSeq: 1,
                anchorOrdinal: 8,
                prompt: "next",
                rounds: 1,
                toolUsage: [],
                endsAttempt: false,
                tailOrdinal: 9,
                tailAskKind: null,
            },
        ]
        expect(foldAll(source)).toEqual(withIdentities(source, sourceExpected))
        const displayed = ordinals(dropSupersededAdjacentCheckpoints(p.rows))
        expect(displayed).toHaveLength(8)
        const displayExpected: readonly ExpectedTurn[] = [
            { ...sourceExpected[0], tailOrdinal: 5 },
            { ...sourceExpected[1], anchorOrdinal: 6, tailOrdinal: 7 },
        ]
        expect(foldAll(displayed)).toEqual(withIdentities(displayed, displayExpected))
        expect(foldAll(source).map(({ anchorOrdinal }) => anchorOrdinal)).toEqual([0, 8])
        expect(foldAll(displayed).map(({ anchorOrdinal }) => anchorOrdinal)).toEqual([0, 6])
        expect(p.rows).toHaveLength(10)
    })

    it("limits prompt previews to 500 characters and keeps empty prompts without changing source rows", () => {
        const p = new ProducerRows()
        const text = `${"a".repeat(500)}hidden suffix`
        p.task(text)
        const empty = p.directInput("")
        empty.text = undefined
        const rows = ordinals(p.rows)
        expect(foldAll(rows)).toEqual(
            withIdentities(rows, [
                {
                    seq: 0,
                    attemptSeq: 0,
                    anchorOrdinal: 0,
                    prompt: "a".repeat(500),
                    rounds: 0,
                    toolUsage: [],
                    endsAttempt: false,
                    tailOrdinal: 0,
                    tailAskKind: null,
                },
                {
                    seq: 1,
                    attemptSeq: 0,
                    anchorOrdinal: 1,
                    prompt: "",
                    rounds: 0,
                    toolUsage: [],
                    endsAttempt: false,
                    tailOrdinal: 1,
                    tailAskKind: null,
                },
            ]),
        )
        expect(p.rows[0].text).toBe(text)
        expect(p.rows[1].text).toBeUndefined()
    })
})
