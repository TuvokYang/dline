// @vitest-environment jsdom
import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { MessageRenderer } from "../chat-view/components/messages/MessageRenderer"
import type { MessageHandlers } from "../chat-view/types/chatTypes"
import { filterVisibleMessages, groupLowStakesTools, groupMessages } from "../chat-view/utils/messageUtils"

void React

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: false,
        taskViewState: { taskId: "task-1", phase: "completed" },
        currentTaskItem: { id: "task-1" },
        mode: "act",
    }),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: false,
        taskViewState: { taskId: "task-1", phase: "completed" },
        currentTaskItem: { id: "task-1" },
        mode: "act",
    }),
}))

const messageHandlers: MessageHandlers = {
    handleSendMessage: vi.fn(async () => undefined),
    handleTaskCloseButtonClick: vi.fn(),
    startNewTask: vi.fn(async () => undefined),
}

/** Render the conversation through the same filter → group → row pipeline ChatView uses. */
const renderConversation = (messages: UiMessage[]) => {
    const grouped = groupLowStakesTools(groupMessages(filterVisibleMessages(messages)))
    render(
        <div>
            {grouped.map((item, index) => (
                <MessageRenderer
                    checkpointAttachments={new Map()}
                    expandedRows={{}}
                    footerActive={false}
                    groupedMessages={grouped}
                    index={index}
                    key={Array.isArray(item) ? item[0]?.ts : item.ts}
                    messageHandlers={messageHandlers}
                    messageOrGroup={item}
                    modifiedMessages={messages}
                    onAddToInput={vi.fn()}
                    onFollowupOptionSelect={vi.fn(async () => undefined)}
                    onHeightChange={vi.fn()}
                    onSetQuote={vi.fn()}
                    onToggleExpand={vi.fn()}
                />
            ))}
        </div>,
    )
}

describe("reasoning row ownership", () => {
    it("renders a failed request's reasoning once, from the reasoning row only", () => {
        // A stream failure keeps its request row visible so the error can be shown.
        // The reasoning that followed it already has its own row; the request row
        // must not draw it a second time.
        renderConversation([
            {
                ts: 1,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({ cost: 0.01, streamingFailedMessage: "stream dropped" }),
            },
            { ts: 2, type: "say", say: "reasoning", text: "**Performing typechecking**" },
        ])

        expect(screen.getAllByRole("button", { name: /^Thinking/ })).toHaveLength(1)
    })
})
