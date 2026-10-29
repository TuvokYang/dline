import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, within } from "@testing-library/react"
import React, { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { isActivityFold, isExplorationRun } from "../../utils/chatRowKinds"
import { groupChatRows, isToolGroup } from "../../utils/messageUtils"
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
 * The rows the standard level draws between the user message and the turn end.
 * A finished turn folds exactly these rows, so they are what an expanded fold
 * must draw again.
 */
const standardRows = groupChatRows(finishedTurnTranscript)
const standardMembers = standardRows.slice(1, -1)
const standardSingleRowTimestamps = standardMembers.flatMap((row) => (Array.isArray(row) ? [] : [row.ts]))

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

const header = () => screen.getByTestId("activity-fold-header")
const drawnMessageTimestamps = (root: HTMLElement | Document = document) =>
    Array.from(root.querySelectorAll<HTMLElement>("[data-message-ts]")).map((element) => Number(element.dataset.messageTs))

describe("ActivityFoldRenderer", () => {
    it("folds the same rows the standard level draws between the user message and the turn end", () => {
        const fold = groupChatRows(finishedTurnTranscript, undefined, { level: "turn" }).find(isActivityFold)

        expect(fold?._children.map(rowIdentity)).toEqual(standardMembers.map(rowIdentity))
        // The transcript exercises nested groups inside the fold.
        expect(standardMembers.some(isExplorationRun)).toBe(true)
        expect(standardMembers.some((row) => isToolGroup(row) && !isExplorationRun(row))).toBe(true)
    })

    it("draws a collapsed fold as its summary and none of its members", () => {
        render(<Harness messages={finishedTurnTranscript} />)

        // 13, 23, 33, 34 are tool calls; 42 is the command; 10, 20, 30, 40 are restore points; 32 is the message.
        expect(screen.getByRole("button", { name: "4 tool calls · 1 command · 4 checkpoints · 1 message" })).toBe(header())
        expect(header()).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByTestId("activity-fold-children")).not.toBeInTheDocument()
        expect(drawnMessageTimestamps()).toEqual([])
        expect(screen.queryByTestId("tool-group-scroll")).not.toBeInTheDocument()
    })

    it("expands a fold from its header", () => {
        render(<Harness messages={finishedTurnTranscript} />)

        fireEvent.click(header())

        expect(header()).toHaveAttribute("aria-expanded", "true")
        const children = screen.getByTestId("activity-fold-children")
        expect(drawnMessageTimestamps(children)).toEqual(standardSingleRowTimestamps)
        expect(within(children).getByTestId("tool-group-scroll")).toBeInTheDocument()
        expect(within(children).getByRole("button", { name: /^Dline read/ })).toBeInTheDocument()
    })

    it("draws no member as the list's last row", () => {
        render(<Harness messages={finishedTurnTranscript} />)
        fireEvent.click(header())

        const members = screen.getByTestId("activity-fold-children").querySelectorAll("[data-message-ts]")
        // The last member is the command row, which would get the last row's bottom padding.
        expect(Number((members[members.length - 1] as HTMLElement).dataset.messageTs)).toBe(42)
        for (const member of members) expect(member).not.toHaveClass("pb-2.5")
    })

    it("keeps nested groups expandable inside an expanded fold", () => {
        render(<Harness messages={finishedTurnTranscript} />)
        fireEvent.click(header())
        const children = screen.getByTestId("activity-fold-children")
        const runHeader = within(children).getByRole("button", { name: /^Dline read/ })

        expect(runHeader).toHaveAttribute("aria-expanded", "false")
        fireEvent.click(runHeader)

        expect(runHeader).toHaveAttribute("aria-expanded", "true")
        expect(within(children).getAllByTestId("exploration-round")).toHaveLength(2)
        // Expanding the nested run leaves the fold open.
        expect(header()).toHaveAttribute("aria-expanded", "true")
    })

    it("folds back to the summary when the header is clicked again", () => {
        render(<Harness messages={finishedTurnTranscript} />)

        fireEvent.click(header())
        fireEvent.click(header())

        expect(header()).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByTestId("activity-fold-children")).not.toBeInTheDocument()
        expect(drawnMessageTimestamps()).toEqual([])
    })
})
