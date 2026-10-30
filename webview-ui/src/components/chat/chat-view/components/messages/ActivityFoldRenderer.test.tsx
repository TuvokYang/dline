import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import React, { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { projectFoldExpansion } from "../../utils/activityFolds"
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
    const rows = projectFoldExpansion(groupChatRows(finishedTurnTranscript, undefined, { level }), expandedFolds)
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
    ] as const)("%s fully expands to the Standard row order without wrappers or indentation", (level) => {
        const standard = render(<Harness level="none" />)
        const expected = renderedRows(standard.container)
        standard.unmount()
        const folded = render(<Harness level={level} />)
        while (screen.queryAllByTestId("activity-fold-header").length > 0)
            fireEvent.click(screen.getAllByTestId("activity-fold-header")[0])
        expect(renderedRows(folded.container)).toEqual(expected)
        expect(folded.container.querySelector("[data-fold-id]")).toBeNull()
        expect(folded.container.querySelector('[data-testid="activity-fold-children"]')).toBeNull()
        expect(
            folded.container.querySelector('[data-message-ts="32"]')?.closest("[data-row-ts]")?.getAttribute("data-row-ts"),
        ).toBe("32")
    })

    it("opens one segment without opening its neighbours, and can collapse it again externally", () => {
        const { container } = render(<Harness level="message_segment" />)
        expect(screen.getAllByTestId("activity-fold-header")).toHaveLength(2)
        fireEvent.click(screen.getAllByTestId("activity-fold-header")[0])
        expect(screen.getAllByTestId("activity-fold-header")).toHaveLength(1)
        expect(container.querySelector('[data-row-ts="10"] [data-fold-id]')).toBeNull()
        expect(container.querySelector('[data-fold-id="segment:33"]')).not.toBeNull()
        fireEvent.click(screen.getByRole("button", { name: "Collapse all" }))
        expect(screen.getAllByTestId("activity-fold-header")).toHaveLength(2)
    })
})
