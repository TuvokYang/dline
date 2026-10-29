import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, within } from "@testing-library/react"
import React, { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { type ExplorationRun, isExplorationRun } from "../../utils/chatRowKinds"
import { groupChatRows } from "../../utils/messageUtils"
import { ExplorationRunRenderer } from "./ExplorationRunRenderer"

void React

vi.mock("./CheckpointMarker", () => ({
    CheckpointMarker: ({ message }: { message: UiMessage }) => <div data-testid="checkpoint" data-ts={message.ts} />,
}))

const openFile = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openFileRelativePath: openFile } }))

const request = (ts: number): UiMessage => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.01 }) })
const checkpoint = (ts: number): UiMessage => ({
    ts,
    type: "say",
    say: "checkpoint_created",
    lastCheckpointHash: ["files-1"],
    checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
})
const reasoning = (ts: number): UiMessage => ({ ts, type: "say", say: "reasoning", text: `thought ${ts}` })
const tool = (ts: number, payload: Record<string, unknown>): UiMessage => ({
    ts,
    type: "say",
    say: "tool",
    text: JSON.stringify(payload),
})

const transcript: UiMessage[] = [
    checkpoint(10),
    request(11),
    reasoning(12),
    tool(13, { tool: "readFile", path: "src/first.ts" }),
    checkpoint(20),
    request(21),
    reasoning(22),
    tool(23, { tool: "searchFiles", path: "src", regex: "needle" }),
    checkpoint(30),
    request(31),
    reasoning(32),
    tool(33, { tool: "readFile", path: "src/third.ts" }),
]

function buildRun(messages: UiMessage[]): ExplorationRun {
    const run = groupChatRows(messages).find(isExplorationRun)
    if (!run) throw new Error("expected the transcript to fold into one run")
    return run
}

/** Owns expansion the way the chat list does: one flag per message timestamp. */
function Harness({ run }: { run: ExplorationRun }) {
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
    return (
        <ExplorationRunRenderer
            allMessages={transcript}
            expandedRows={expandedRows}
            isLastActivity={false}
            isLastRow={false}
            onToggleExpand={(ts) => setExpandedRows((rows) => ({ ...rows, [ts]: !rows[ts] }))}
            run={run}
        />
    )
}

const checkpointTimestamps = () => screen.queryAllByTestId("checkpoint").map((element) => Number(element.dataset.ts))
const SUMMARY = "Dline read 2 files, performed 1 search · 3 thoughts · 3 rounds"
const CALLS = ["src/first.ts", '"needle" in src/', "src/third.ts"]

/** Names of the tool-call rows, in the order they are drawn. */
const drawnCalls = () =>
    screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "")
        .filter((name) => CALLS.includes(name))

describe("ExplorationRunRenderer", () => {
    it("collapsed, keeps the first restore point and lists every round's calls in one group without thinking", () => {
        render(<Harness run={buildRun(transcript)} />)

        expect(screen.getByRole("button", { name: SUMMARY })).toHaveAttribute("aria-expanded", "false")
        expect(checkpointTimestamps()).toEqual([10])
        expect(screen.queryAllByRole("button", { name: "Thinking" })).toHaveLength(0)
        expect(screen.queryAllByTestId("exploration-round")).toHaveLength(0)
        for (const name of CALLS) expect(screen.getByRole("button", { name })).toBeInTheDocument()
        expect(drawnCalls()).toEqual(CALLS)
    })

    it("collapsed, opens a file from its row without unfolding the run", () => {
        openFile.mockClear()
        render(<Harness run={buildRun(transcript)} />)

        fireEvent.click(screen.getByRole("button", { name: "src/third.ts" }))

        expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ value: "src/third.ts" }))
        expect(screen.getByRole("button", { name: SUMMARY })).toHaveAttribute("aria-expanded", "false")
    })

    it("expanded, lists every round with its own restore point, thinking and tool calls", () => {
        render(<Harness run={buildRun(transcript)} />)

        fireEvent.click(screen.getByRole("button", { name: SUMMARY }))

        expect(screen.getByRole("button", { name: SUMMARY })).toHaveAttribute("aria-expanded", "true")
        expect(checkpointTimestamps()).toEqual([10, 20, 30])
        const rounds = screen.getAllByTestId("exploration-round")
        expect(rounds).toHaveLength(3)
        expect(within(rounds[0]).getByRole("button", { name: "Thinking" })).toBeInTheDocument()
        expect(within(rounds[0]).getByRole("button", { name: "src/first.ts" })).toBeInTheDocument()
        expect(within(rounds[1]).getByRole("button", { name: '"needle" in src/' })).toBeInTheDocument()
        expect(within(rounds[2]).getByRole("button", { name: "src/third.ts" })).toBeInTheDocument()
        // The merged list gives way to the rounds, so each call is drawn once.
        expect(drawnCalls()).toEqual(CALLS)
    })

    it("shows the thinking of the round the user clicks, and only that one", () => {
        render(<Harness run={buildRun(transcript)} />)
        fireEvent.click(screen.getByRole("button", { name: SUMMARY }))

        const second = screen.getAllByTestId("exploration-round")[1]
        fireEvent.click(within(second).getByRole("button", { name: "Thinking" }))

        expect(within(second).getByText("thought 22")).toBeInTheDocument()
        expect(screen.queryByText("thought 12")).not.toBeInTheDocument()
        expect(screen.queryByText("thought 32")).not.toBeInTheDocument()
    })

    it("folds back to the summary when the header is clicked again", () => {
        render(<Harness run={buildRun(transcript)} />)
        const header = screen.getByRole("button", { name: SUMMARY })

        fireEvent.click(header)
        fireEvent.click(header)

        expect(header).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryAllByTestId("exploration-round")).toHaveLength(0)
        expect(checkpointTimestamps()).toEqual([10])
        expect(drawnCalls()).toEqual(CALLS)
    })
})
