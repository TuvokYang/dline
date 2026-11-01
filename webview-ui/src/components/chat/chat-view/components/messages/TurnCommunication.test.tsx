import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import React, { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { isActivityFold } from "../../utils/chatRowKinds"
import { groupChatRows } from "../../utils/messageUtils"
import { rowIdentity } from "../../utils/rowCoordinate"
import { MessageRenderer } from "./MessageRenderer"

void React

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ mode: "act" }) }))
vi.mock("@/components/chat/ChatRow", () => ({
    default: ({ message }: { message: UiMessage }) => <div data-chat-row-ts={message.ts} />,
}))
vi.mock("./CheckpointMarker", () => ({ CheckpointMarker: () => null }))
vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openFileRelativePath: vi.fn(async () => undefined) } }))

const say = (ts: number, say: UiMessage["say"], text = ""): UiMessage => ({ ts, type: "say", say, text })
const command = (ts: number): UiMessage => ({
    ts,
    type: "ask",
    ask: "command",
    text: "npm run lint",
    commandStatus: "completed",
    exitCode: 0,
})
const completion: UiMessage = { ts: 99, type: "ask", ask: "completion_result", text: "Done." }
const update = (ts: number, tool: string) => say(ts, "tool", JSON.stringify({ tool, content: "Progress update" }))
const read = (ts: number) => say(ts, "tool", JSON.stringify({ tool: "readFile", path: "src/a.ts" }))
const transcript = (middle: UiMessage[]): UiMessage[] => [say(1, "task", "Inspect the build"), ...middle, completion]

const handlers: MessageHandlers = {
    handleSendMessage: async () => undefined,
    handleTaskCloseButtonClick: async () => undefined,
    startNewTask: async () => undefined,
}

function Harness({ messages }: { messages: UiMessage[] }) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    const rows = groupChatRows(messages, undefined, { level: "message_segment" })
    return (
        <>
            {rows.map((row, index) => (
                <MessageRenderer
                    checkpointAttachments={indexPreEditCheckpointAttachments(messages)}
                    expandedRows={{}}
                    foldExpansion={{
                        expanded,
                        toggle: (id) => setExpanded((current) => ({ ...current, [id]: !current[id] })),
                    }}
                    footerActive={false}
                    groupedMessages={rows}
                    index={index}
                    key={rowIdentity(row)}
                    messageHandlers={handlers}
                    messageOrGroup={row}
                    modifiedMessages={messages}
                    onAddToInput={() => undefined}
                    onFollowupOptionSelect={async () => undefined}
                    onHeightChange={() => undefined}
                    onSetQuote={() => undefined}
                    onToggleExpand={() => undefined}
                />
            ))}
        </>
    )
}

const drawn = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-message-ts]")).map((element) => Number(element.dataset.messageTs))
const members = (messages: UiMessage[]) =>
    groupChatRows(messages, undefined, { level: "message_segment" })
        .filter(isActivityFold)
        .map((fold) => fold.map(({ ts }) => ts))

describe("Message segments preserve communication", () => {
    // These cases catch both folding an update and hiding it when the surrounding folds toggle.
    it.each([
        ["assistant text", say(20, "text", "I found the problem")],
        ["working_respond", update(20, "actModeRespond")],
        ["phase_report", update(20, "statusUpdate")],
    ])("keeps %s in transcript order outside collapsed execution blocks", (_name, message) => {
        const messages = transcript([command(10), message, command(30)])
        expect(members(messages)).toEqual([[10], [30]])
        render(<Harness messages={messages} />)
        expect(drawn()).toEqual([1, 20, 99])
        const headers = screen.getAllByTestId("activity-fold-header")
        expect(headers).toHaveLength(2)
        for (const header of headers) expect(header).toHaveAttribute("aria-expanded", "false")
        fireEvent.click(headers[0])
        expect(drawn()).toEqual([1, 10, 20, 99])
        // The header stays, so the same control closes the block it opened.
        expect(screen.getAllByTestId("activity-fold-header")).toHaveLength(2)
        expect(screen.getAllByTestId("activity-fold-header")[0]).toHaveAttribute("aria-expanded", "true")
        fireEvent.click(screen.getAllByTestId("activity-fold-header")[0])
        expect(drawn()).toEqual([1, 20, 99])
        expect(screen.getAllByTestId("activity-fold-header")).toHaveLength(2)
        expect(screen.getAllByTestId("activity-fold-header")[0]).toHaveAttribute("aria-expanded", "false")
    })

    it("does not lose text written after a low-stakes tool group", () => {
        const messages = transcript([read(10), say(20, "text", "The first read is complete"), read(30)])
        const rows = groupChatRows(messages, undefined, { level: "message_segment" })
        expect(rows.filter((row) => !Array.isArray(row)).map((row) => row.ts)).toEqual([1, 20, 99])
        expect(members(messages)).toEqual([[10], [30]])
        render(<Harness messages={messages} />)
        expect(drawn()).toEqual([1, 20, 99])
    })

    it("keeps prose between browser actions outside the browser activity folds", () => {
        const messages = transcript([
            say(10, "browser_action_launch", "https://example.com"),
            say(11, "browser_action_result", JSON.stringify({ currentUrl: "https://example.com" })),
            say(20, "text", "The page loaded; I will inspect it"),
            say(30, "browser_action", JSON.stringify({ action: "close" })),
            say(31, "browser_action_result", JSON.stringify({ currentUrl: "https://example.com" })),
        ])
        const rows = groupChatRows(messages, undefined, { level: "message_segment" })
        expect(rows.filter((row) => !Array.isArray(row)).map((row) => row.ts)).toEqual([1, 20, 99])
        expect(members(messages)).toEqual([
            [10, 11],
            [30, 31],
        ])
        render(<Harness messages={messages} />)
        expect(drawn()).toEqual([1, 20, 99])
    })

    it("does not manufacture folds for a turn containing only communication", () => {
        const messages = transcript([say(10, "text", "Checking"), update(20, "actModeRespond"), update(30, "statusUpdate")])
        expect(members(messages)).toEqual([])
        render(<Harness messages={messages} />)
        expect(drawn()).toEqual([1, 10, 20, 30, 99])
        expect(screen.queryByTestId("activity-fold-header")).toBeNull()
    })
})
