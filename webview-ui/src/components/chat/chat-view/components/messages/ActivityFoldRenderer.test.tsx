import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import React, { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { isActivityFold } from "../../utils/chatRowKinds"
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

/** The list projects folds before rendering, as ChatView does. */
function Harness({ level = "user_turn" }: { level?: "none" | "message_segment" | "user_turn" }) {
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
    const [expandedFolds, setExpandedFolds] = useState<Record<string, boolean>>({})
    const rows = groupChatRows(finishedTurnTranscript, undefined, { level })
    return (
        <>
            <button onClick={() => setExpandedFolds({})} type="button">
                Collapse all
            </button>
            {rows.map((row, index) => (
                <div className="contents" data-row-ts={Array.isArray(row) ? row[0].ts : row.ts} key={rowIdentity(row)}>
                    <MessageRenderer
                        checkpointAttachments={indexPreEditCheckpointAttachments(finishedTurnTranscript)}
                        expandedRows={expandedRows}
                        foldExpansion={{
                            expanded: expandedFolds,
                            toggle: (id) => setExpandedFolds((current) => ({ ...current, [id]: !current[id] })),
                        }}
                        footerActive={false}
                        groupedMessages={rows}
                        index={index}
                        messageHandlers={messageHandlers}
                        messageOrGroup={row}
                        modifiedMessages={finishedTurnTranscript}
                        onAddToInput={() => undefined}
                        onFollowupOptionSelect={async () => undefined}
                        onHeightChange={() => undefined}
                        onSetQuote={() => undefined}
                        onToggleExpand={(ts) => setExpandedRows((current) => ({ ...current, [ts]: !current[ts] }))}
                    />
                </div>
            ))}
        </>
    )
}

const renderedRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>("[data-row-ts]"), (row) => row.dataset.rowTs)

describe("ActivityFoldRenderer", () => {
    it("draws a whole-turn summary including prose, not nested request folds", () => {
        const rows = groupChatRows(finishedTurnTranscript, undefined, { level: "user_turn" })
        expect(rows.map(rowIdentity)).toEqual(["1", "turn:10", "51"])
        expect(rows.filter(isActivityFold)[0]._children.some(isActivityFold)).toBe(false)
        render(<Harness />)
        expect(screen.getByTestId("activity-fold-header")).toHaveAttribute("aria-expanded", "false")
        expect(document.querySelector('[data-message-ts="32"]')).toBeNull()
    })

    it.each([
        "message_segment",
        "user_turn",
    ] as const)("%s opens every block and draws each block's own members beneath it", (level) => {
        const standard = render(<Harness level="none" />)
        const expectedRowCount = renderedRows(standard.container).length
        standard.unmount()
        const folded = render(<Harness level={level} />)
        const blocks = groupChatRows(finishedTurnTranscript, undefined, { level }).filter(isActivityFold)
        expect(blocks.length).toBeGreaterThan(0)
        // Closed: no member is drawn, but every header is.
        expect(folded.container.querySelectorAll('[data-testid="activity-fold-children"]')).toHaveLength(0)
        expect(screen.getAllByTestId("activity-fold-header")).toHaveLength(blocks.length)

        for (const header of screen.getAllByTestId("activity-fold-header")) fireEvent.click(header)
        const opened = folded.container.querySelectorAll('[data-testid="activity-fold-children"]')
        expect(opened).toHaveLength(blocks.length)
        // Each open block draws exactly the members it holds, and nothing else.
        blocks.forEach((block, index) => {
            const drawnTs = Array.from(opened[index].querySelectorAll<HTMLElement>("[data-message-ts]"), (row) =>
                Number(row.dataset.messageTs),
            )
            const ownTs = (Array.isArray(block) ? block : [block]).map(({ ts }) => ts)
            for (const ts of drawnTs) expect(ownTs).toContain(ts)
            // A member that drew a plain message must be present.
            for (const member of Array.isArray(block) ? block : [block]) {
                if (Array.isArray(member)) continue
                if (member.say === "checkpoint_created" || member.say === "reasoning") continue
                if (member.say === "tool" || member.ask === "tool") continue
                expect(drawnTs).toContain(member.ts)
            }
        })
        // The list still holds one row per block, plus the rows no block took.
        const topLevel = blocks.length + groupChatRows(finishedTurnTranscript, undefined, { level }).length - blocks.length
        expect(renderedRows(folded.container).length).toBe(topLevel)
        expect(expectedRowCount).toBeGreaterThan(0)
    })

    it("opens one segment without opening its neighbours, and the same header closes it again", () => {
        const { container } = render(<Harness level="message_segment" />)
        const headers = () => screen.getAllByTestId("activity-fold-header")
        expect(headers()).toHaveLength(2)
        fireEvent.click(headers()[0])
        // Both blocks keep their header; only the clicked one is open.
        expect(headers()).toHaveLength(2)
        expect(headers()[0]).toHaveAttribute("aria-expanded", "true")
        expect(headers()[1]).toHaveAttribute("aria-expanded", "false")
        expect(container.querySelector('[data-fold-id="segment:10"] [data-testid="activity-fold-children"]')).not.toBeNull()
        expect(container.querySelector('[data-fold-id="segment:33"] [data-testid="activity-fold-children"]')).toBeNull()
        // Clicking the same header again closes what it opened.
        fireEvent.click(headers()[0])
        expect(headers()).toHaveLength(2)
        expect(headers()[0]).toHaveAttribute("aria-expanded", "false")
        fireEvent.click(screen.getByRole("button", { name: "Collapse all" }))
        for (const header of headers()) expect(header).toHaveAttribute("aria-expanded", "false")
    })
})
