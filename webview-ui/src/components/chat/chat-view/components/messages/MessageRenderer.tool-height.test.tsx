import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { ROW_SOURCE_INDEX_ATTRIBUTE, ROW_TRAJECTORY_INDEX_ATTRIBUTE, ROW_TS_ATTRIBUTE } from "../../utils/viewportRowAnchor"
import { createMessageRenderer, MessageRenderer, rowSourceIndex } from "./MessageRenderer"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ mode: "act", onRelinquishControl: () => () => undefined }),
}))

vi.mock("@/components/chat/BrowserSessionRow", () => ({
    default: () => <div data-testid="browser-session-row" />,
}))

vi.mock("@/components/chat/ChatRow", () => ({
    default: () => <div data-testid="chat-row" />,
}))

vi.mock("../../utils/messageUtils", () => ({
    isTextMessagePendingToolCall: () => false,
    isToolGroup: (value: UiMessage | UiMessage[]) => Array.isArray(value),
    resolveMessageRowExpanded: () => false,
}))

vi.mock("./ToolGroupRenderer", () => ({
    ToolGroupRenderer: () => <div data-testid="tool-group-renderer" />,
}))

const messageHandlers: MessageHandlers = {
    handleSendMessage: vi.fn(async () => undefined),
    handleTaskCloseButtonClick: vi.fn(),
    startNewTask: vi.fn(async () => undefined),
}

describe("MessageRenderer tool-group height boundary", () => {
    it("attaches a pre-edit checkpoint to its source tool card", () => {
        const tool: UiMessage = {
            ts: 70,
            type: "say",
            say: "tool",
            text: JSON.stringify({ tool: "editedExistingFile", path: "src/example.ts" }),
        }
        const checkpoint: UiMessage = {
            ts: 71,
            type: "say",
            say: "checkpoint_created",
            checkpointSource: {
                kind: "pre_edit",
                toolTs: 70,
                toolName: "replace_in_file",
                dlineTid: "tool-70",
            },
        }

        render(
            <MessageRenderer
                checkpointAttachments={new Map([[70, [checkpoint]]])}
                expandedRows={{}}
                footerActive={false}
                groupedMessages={[tool]}
                index={0}
                messageHandlers={messageHandlers}
                messageOrGroup={tool}
                modifiedMessages={[tool, checkpoint]}
                onAddToInput={vi.fn()}
                onFollowupOptionSelect={vi.fn(async () => undefined)}
                onHeightChange={vi.fn()}
                onSetQuote={vi.fn()}
                onToggleExpand={vi.fn()}
            />,
        )

        expect(screen.getByTestId("chat-row")).toBeInTheDocument()
        expect(screen.getByText("Before replace_in_file")).toBeInTheDocument()
    })

    it("caps grouped tool rows at 60vh without modifying ToolGroupRenderer", () => {
        const group: UiMessage[] = [
            { ts: 1, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "src/example.ts" }) },
        ]

        render(
            <MessageRenderer
                checkpointAttachments={new Map()}
                expandedRows={{}}
                footerActive={false}
                groupedMessages={[group]}
                index={0}
                messageHandlers={messageHandlers}
                messageOrGroup={group}
                modifiedMessages={group}
                onAddToInput={vi.fn()}
                onFollowupOptionSelect={vi.fn(async () => undefined)}
                onHeightChange={vi.fn()}
                onSetQuote={vi.fn()}
                onToggleExpand={vi.fn()}
            />,
        )

        expect(screen.getByTestId("tool-group-renderer")).toBeInTheDocument()
    })

    it("places a grouped row in the conversation by its first message, which the row itself does not name", () => {
        const group: UiMessage[] = [
            { ts: 41, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "a.ts" }) },
            { ts: 42, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "b.ts" }) },
        ]
        const renderRow = createMessageRenderer(
            [group],
            group,
            {},
            vi.fn(),
            vi.fn(),
            vi.fn(),
            vi.fn(),
            vi.fn(async () => undefined),
            messageHandlers,
            false,
        )

        const { container } = render(renderRow(0, group))

        const rows = container.querySelectorAll(`[${ROW_TS_ATTRIBUTE}]`)
        expect([...rows].map((row) => row.getAttribute(ROW_TS_ATTRIBUTE))).toEqual(["41"])
        expect(rows[0]).toContainElement(screen.getByTestId("tool-group-renderer"))
        expect(container.querySelector("[data-message-ts]")).toBeNull()
    })

    it("keeps real group indices separate from transient reading context and retains timestamp attributes", () => {
        const task: UiMessage = { ts: 900, messageIndex: 0, type: "say", say: "text" }
        const transient: UiMessage = { ts: 100, type: "say", say: "text", partial: true }
        const member: UiMessage = { ts: 80, messageIndex: 37, type: "say", say: "tool" }
        const group: UiMessage[] = [
            { ts: 90, type: "say", say: "tool", partial: true },
            member,
            { ts: 70, messageIndex: 43, type: "say", say: "tool" },
        ]
        const tail: UiMessage = { ts: 60, type: "say", say: "text", partial: true }
        const rows = [task, transient, group, tail]
        const renderRow = createMessageRenderer(
            rows,
            [task, transient, ...group, tail],
            {},
            vi.fn(),
            vi.fn(),
            vi.fn(),
            vi.fn(),
            vi.fn(async () => undefined),
            messageHandlers,
            false,
        )
        const { container } = render(
            <>
                {rows.map((row, index) => (
                    <React.Fragment key={index}>{renderRow(index, row)}</React.Fragment>
                ))}
            </>,
        )
        const metadata = [...container.querySelectorAll(`[${ROW_TS_ATTRIBUTE}]`)].map((row) => [
            row.getAttribute(ROW_TS_ATTRIBUTE),
            row.getAttribute(ROW_SOURCE_INDEX_ATTRIBUTE),
            row.getAttribute(ROW_TRAJECTORY_INDEX_ATTRIBUTE),
        ])
        expect(metadata).toEqual([
            ["900", "0", "0"],
            ["100", null, "0"],
            ["90", "37", "37"],
            ["60", null, "43"],
        ])
        expect(rowSourceIndex(group)).toBe(37)
        expect(rowSourceIndex(transient)).toBeUndefined()
        expect([transient, group[0], tail].map((message) => message.messageIndex)).toEqual([undefined, undefined, undefined])
        // Virtuoso's coordinate can lag the item for one frame: metadata must still describe that actual item.
        const staleCoordinate = render(renderRow(0, group)).container.querySelector(`[${ROW_SOURCE_INDEX_ATTRIBUTE}]`)
        expect(staleCoordinate?.getAttribute(ROW_SOURCE_INDEX_ATTRIBUTE)).toBe("37")
        expect(staleCoordinate?.getAttribute(ROW_TRAJECTORY_INDEX_ATTRIBUTE)).toBe("37")
    })
})
