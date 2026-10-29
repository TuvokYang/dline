import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, within } from "@testing-library/react"
import React, { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { type ActivityFold, isActivityFold } from "../../utils/chatRowKinds"
import { groupChatRows } from "../../utils/messageUtils"
import { rowIdentity } from "../../utils/rowCoordinate"
import { finishedTurnTranscript } from "./activityFoldStoryFixtures"
import { MessageRenderer } from "./MessageRenderer"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ mode: "act" }),
}))

vi.mock("@/components/chat/ChatRow", () => ({
    default: ({ message }: { message: UiMessage }) => <div data-chat-row-ts={message.ts} />,
}))

vi.mock("./CheckpointMarker", () => ({
    CheckpointMarker: ({ message }: { message: UiMessage }) => <div data-testid="checkpoint" data-ts={message.ts} />,
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openFileRelativePath: vi.fn(() => Promise.resolve()) } }))

const messageHandlers: MessageHandlers = {
    handleSendMessage: vi.fn(async () => undefined),
    handleTaskCloseButtonClick: vi.fn(),
    startNewTask: vi.fn(async () => undefined),
}

/**
 * The messages each round of the finished turn draws: a round opens at its
 * request, and its restore point (10, 20, 30, 40) leads it.
 */
const ROUND_ROWS = [
    [10, 12, 13],
    [20, 22, 23],
    [30, 32, 33, 34],
    [40, 42],
]
/** The same rounds without their tool calls (13, 23, 33, 34), which a tool group draws. */
const ROUND_SINGLE_ROWS = [
    [10, 12],
    [20, 22],
    [30, 32],
    [40, 42],
]

/** Owns row and fold expansion the way the chat does: separate key spaces. */
function Harness({ messages }: { messages: UiMessage[] }) {
    const rows = groupChatRows(messages, undefined, { level: "turn" })
    const index = rows.findIndex(isActivityFold)
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
    const [expandedFolds, setExpandedFolds] = useState<Record<string, boolean>>({})
    return (
        <MessageRenderer
            checkpointAttachments={indexPreEditCheckpointAttachments(messages)}
            expandedRows={expandedRows}
            foldExpansion={{
                expanded: expandedFolds,
                toggle: (foldId) => setExpandedFolds((folds) => ({ ...folds, [foldId]: !folds[foldId] })),
            }}
            footerActive={false}
            groupedMessages={rows}
            index={index}
            messageHandlers={messageHandlers}
            messageOrGroup={rows[index]}
            modifiedMessages={messages}
            onAddToInput={vi.fn()}
            onFollowupOptionSelect={vi.fn(async () => undefined)}
            onHeightChange={vi.fn()}
            onSetQuote={vi.fn()}
            onToggleExpand={(ts) => setExpandedRows((rows) => ({ ...rows, [ts]: !rows[ts] }))}
        />
    )
}

const headers = () => screen.getAllByTestId("activity-fold-header")
const turnHeader = () => headers()[0]
const roundHeaders = () => headers().slice(1)
const drawnMessageTimestamps = (root: HTMLElement | Document = document) =>
    Array.from(root.querySelectorAll<HTMLElement>("[data-message-ts]")).map((element) => Number(element.dataset.messageTs))
const drawnRowTimestamps = (row: ActivityFold["_children"][number]): number[] =>
    isActivityFold(row) ? row._children.flatMap(drawnRowTimestamps) : Array.isArray(row) ? row.map((m) => m.ts) : [row.ts]

describe("ActivityFoldRenderer", () => {
    it("folds a finished turn into one turn fold holding one round fold per round", () => {
        const rows = groupChatRows(finishedTurnTranscript, undefined, { level: "turn" })
        const fold = rows.find(isActivityFold)
        if (!fold) throw new Error("expected the finished turn to fold")

        // The user message and the completion stay outside the fold.
        expect(rows.filter((row) => !isActivityFold(row)).map(rowIdentity)).toEqual(["1", "51"])
        expect(fold._foldKind).toBe("turn")
        expect(fold._children.every((child) => isActivityFold(child) && child._foldKind === "round")).toBe(true)
        expect(fold._children.map(drawnRowTimestamps)).toEqual(ROUND_ROWS)
    })

    it("draws a collapsed turn fold as its summary and none of its rounds", () => {
        render(<Harness messages={finishedTurnTranscript} />)

        expect(
            screen.getByRole("button", { name: "4 rounds · 4 tool calls · 1 command · 2 thoughts · 4 checkpoints · 1 message" }),
        ).toBe(turnHeader())
        expect(headers()).toHaveLength(1)
        expect(turnHeader()).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByTestId("activity-fold-children")).not.toBeInTheDocument()
        expect(drawnMessageTimestamps()).toEqual([])
    })

    it("expands a turn fold into its collapsed round folds", () => {
        render(<Harness messages={finishedTurnTranscript} />)

        fireEvent.click(turnHeader())

        expect(turnHeader()).toHaveAttribute("aria-expanded", "true")
        expect(roundHeaders().map((header) => header.textContent)).toEqual([
            "1 tool call · 1 thought · 1 checkpoint",
            "1 tool call · 1 thought · 1 checkpoint",
            "2 tool calls · 1 checkpoint · 1 message",
            "1 command · 1 checkpoint",
        ])
        for (const header of roundHeaders()) expect(header).toHaveAttribute("aria-expanded", "false")
        expect(drawnMessageTimestamps()).toEqual([])
    })

    it("expands one round inside an expanded turn fold and leaves the others folded", () => {
        render(<Harness messages={finishedTurnTranscript} />)
        fireEvent.click(turnHeader())

        fireEvent.click(roundHeaders()[2])

        expect(roundHeaders().map((header) => header.getAttribute("aria-expanded"))).toEqual(["false", "false", "true", "false"])
        expect(drawnMessageTimestamps()).toEqual(ROUND_SINGLE_ROWS[2])
        const openRound = screen.getAllByTestId("activity-fold")[3]
        expect(within(openRound).getAllByTestId("tool-group-scroll")).toHaveLength(1)
        // Expanding a round leaves the turn fold open.
        expect(turnHeader()).toHaveAttribute("aria-expanded", "true")
    })

    it("draws no member as the list's last row", () => {
        render(<Harness messages={finishedTurnTranscript} />)
        fireEvent.click(turnHeader())
        fireEvent.click(roundHeaders()[3])

        const members = document.querySelectorAll<HTMLElement>("[data-message-ts]")
        // The last member is the command row, which would get the last row's bottom padding.
        expect(Number(members[members.length - 1].dataset.messageTs)).toBe(42)
        for (const member of members) expect(member).not.toHaveClass("pb-2.5")
    })

    it("keeps an opened round open when its turn fold folds and opens again", () => {
        render(<Harness messages={finishedTurnTranscript} />)
        fireEvent.click(turnHeader())
        fireEvent.click(roundHeaders()[0])

        fireEvent.click(turnHeader())
        expect(screen.queryByTestId("activity-fold-children")).not.toBeInTheDocument()
        expect(drawnMessageTimestamps()).toEqual([])

        fireEvent.click(turnHeader())
        expect(roundHeaders()[0]).toHaveAttribute("aria-expanded", "true")
        expect(within(screen.getAllByTestId("activity-fold")[1]).getAllByTestId("activity-fold-children")).toHaveLength(1)
        expect(drawnMessageTimestamps()).toEqual(ROUND_SINGLE_ROWS[0])
    })

    it("folds back to the summary when the turn header is clicked again", () => {
        render(<Harness messages={finishedTurnTranscript} />)

        fireEvent.click(turnHeader())
        fireEvent.click(turnHeader())

        expect(turnHeader()).toHaveAttribute("aria-expanded", "false")
        expect(headers()).toHaveLength(1)
        expect(screen.queryByTestId("activity-fold-children")).not.toBeInTheDocument()
        expect(drawnMessageTimestamps()).toEqual([])
    })
})
