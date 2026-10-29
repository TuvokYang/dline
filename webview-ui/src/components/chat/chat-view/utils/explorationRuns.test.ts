import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { type ExplorationRun, isExplorationRun, isToolGroup } from "./chatRowKinds"
import { groupChatRows } from "./messageUtils"

const request = (ts: number): UiMessage => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.01 }) })
const streamingRequest = (ts: number): UiMessage => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify({}) })
const checkpoint = (ts: number, hash = "files-1", extra: Partial<UiMessage> = {}): UiMessage => ({
    ts,
    type: "say",
    say: "checkpoint_created",
    lastCheckpointHash: [hash],
    checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
    ...extra,
})
const reasoning = (ts: number, partial = false): UiMessage => ({
    ts,
    type: "say",
    say: "reasoning",
    text: `thought ${ts}`,
    ...(partial ? { partial: true } : {}),
})
const tool = (ts: number, payload: Record<string, unknown>, type: "say" | "ask" = "say"): UiMessage =>
    type === "say"
        ? { ts, type, say: "tool", text: JSON.stringify(payload) }
        : { ts, type, ask: "tool", text: JSON.stringify(payload) }
const read = (ts: number) => tool(ts, { tool: "readFile", path: `src/file-${ts}.ts` })
const edit = (ts: number) => tool(ts, { tool: "editedExistingFile", path: "src/changed.ts" })

/** One read-only round as the task writes it: restore point, request, thinking, then a read. */
const readRound = (ts: number, hash = "files-1"): UiMessage[] => [
    checkpoint(ts, hash),
    request(ts + 1),
    reasoning(ts + 2),
    read(ts + 3),
]

/** A compact picture of the rows: a run lists the checkpoints of its rounds, any other row its timestamp. */
const shape = (rows: ReturnType<typeof groupChatRows>) =>
    rows.map((row) => {
        if (isExplorationRun(row)) return `run:${row._rounds.map((round) => round.checkpoint?.ts ?? "-").join(",")}`
        if (isToolGroup(row)) return `tools:${row.map((message) => message.ts).join(",")}`
        return Array.isArray(row) ? "browser" : row.ts
    })

const onlyRun = (rows: ReturnType<typeof groupChatRows>): ExplorationRun => {
    const run = rows.find(isExplorationRun)
    if (!run) throw new Error("expected an exploration run")
    return run
}

describe("exploration runs", () => {
    it("folds consecutive read-only rounds with their thinking and restore points into one row", () => {
        const rows = groupChatRows([...readRound(10), ...readRound(20), ...readRound(30)])

        expect(shape(rows)).toEqual(["run:10,20,30"])
        const entries = onlyRun(rows)._rounds.map((round) =>
            round.entries.map((entry) => (isToolGroup(entry) ? entry.map((message) => message.ts) : entry.ts)),
        )
        expect(entries).toEqual([
            [12, [13]],
            [22, [23]],
            [32, [33]],
        ])
    })

    it("keeps every restore point reachable as a row or as the checkpoint of a folded round", () => {
        const transcript = [
            ...readRound(10),
            ...readRound(20),
            checkpoint(30),
            request(31),
            edit(32),
            ...readRound(40, "files-2"),
            ...readRound(50, "files-2"),
        ]
        const rows = groupChatRows(transcript)

        const reachable = rows.flatMap((row) => {
            if (isExplorationRun(row)) return row._rounds.flatMap((round) => (round.checkpoint ? [round.checkpoint.ts] : []))
            return !Array.isArray(row) && row.say === "checkpoint_created" ? [row.ts] : []
        })
        const written = transcript.filter((message) => message.say === "checkpoint_created").map((message) => message.ts)
        expect(reachable).toEqual(written)
    })

    it("ends the run before a round that changes files and leaves that round's rows standalone", () => {
        const rows = groupChatRows([
            ...readRound(10),
            ...readRound(20),
            checkpoint(30),
            request(31),
            reasoning(32),
            edit(33),
            ...readRound(40, "files-2"),
            ...readRound(50, "files-2"),
        ])

        expect(shape(rows)).toEqual(["run:10,20", 30, 32, 33, "run:40,50"])
    })

    it("starts a new run when the files changed between two read-only rounds", () => {
        const rows = groupChatRows([
            ...readRound(10, "files-1"),
            ...readRound(20, "files-1"),
            ...readRound(30, "files-2"),
            ...readRound(40, "files-2"),
        ])

        expect(shape(rows)).toEqual(["run:10,20", "run:30,40"])
    })

    it("keeps a round that has not called a tool yet outside the run so its thinking stays visible", () => {
        const rows = groupChatRows([
            ...readRound(10),
            ...readRound(20),
            checkpoint(30),
            streamingRequest(31),
            reasoning(32, true),
        ])

        expect(shape(rows)).toEqual(["run:10,20", 30, 32])
    })

    it("keeps one identity while later rounds join the run", () => {
        const first = onlyRun(groupChatRows(readRound(10)))
        const later = onlyRun(groupChatRows([...readRound(10), ...readRound(20), ...readRound(30)]))

        expect(first._rounds).toHaveLength(1)
        expect(later._explorationRunId).toBe(first._explorationRunId)
    })

    it("leaves a lone tool group without thinking or restore point as it is", () => {
        const rows = groupChatRows([request(1), read(2), read(3)])

        expect(shape(rows)).toEqual(["tools:2,3"])
    })

    it("keeps a restore point the user checked out at the head of a run", () => {
        const checkedOut = readRound(20)
        checkedOut[0] = checkpoint(20, "files-1", { isCheckpointCheckedOut: true })

        const rows = groupChatRows([...readRound(10), ...checkedOut, ...readRound(30)])

        expect(shape(rows)).toEqual(["run:10", "run:20,30"])
    })

    // A read still waiting for approval never reaches the chat rows: the footer draws
    // it. Once answered it is a read like any other and folds into the run.
    it("folds an answered read into the run like any read", () => {
        const answered = tool(23, { tool: "readFile", path: "outside/secret.ts" }, "ask")
        const rows = groupChatRows([...readRound(10), checkpoint(20), request(21), reasoning(22), answered])

        expect(shape(rows)).toEqual(["run:10,20"])
    })
})
