import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { MessageRenderer } from "./MessageRenderer"

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

        expect(screen.getByTestId("tool-group-scroll")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
        expect(screen.getByTestId("tool-group-renderer")).toBeInTheDocument()
    })
})
