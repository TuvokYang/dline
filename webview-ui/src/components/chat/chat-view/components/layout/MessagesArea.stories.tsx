import type { UiMessage } from "@shared/ExtensionMessage"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useMemo, useState } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"
import { useChatState } from "../../hooks/useChatState"
import { useScrollBehavior } from "../../hooks/useScrollBehavior"
import type { MessageHandlers } from "../../types/chatTypes"
import { filterVisibleMessages, groupChatRows } from "../../utils/messageUtils"
import { MessagesArea } from "./MessagesArea"

const TASK: UiMessage = { ts: 1, type: "say", say: "task", text: "Scroll regression fixture" }
const INITIAL_MESSAGES: UiMessage[] = Array.from({ length: 80 }, (_, index) => ({
    ts: index + 2,
    type: "say",
    say: "text",
    text: `SCROLL_ROW_${index}\n\n${"A stable paragraph for real row measurement.\n\n".repeat(4)}`,
}))
const LONG_REPORT: UiMessage = {
    ts: 10_000,
    type: "ask",
    ask: "generate_report",
    text: JSON.stringify({
        title: "Long investigation report",
        content: Array.from(
            { length: 120 },
            (_, index) =>
                `## Finding ${index + 1}\n\nA long report paragraph that exercises measured markdown height at task open.`,
        ).join("\n\n"),
    }),
}

const HANDLERS: MessageHandlers = {
    handleSendMessage: async () => {},
    handleTaskCloseButtonClick: async () => {},
    startNewTask: async () => {},
}
const selectOption = async () => {}

interface ScrollFixtureProps {
    initialMessages?: UiMessage[]
}

/** Real chat rendering and scroll logic; only the message transport is controlled. */
function ScrollFixture({ initialMessages = INITIAL_MESSAGES }: ScrollFixtureProps) {
    const base = useExtensionState()
    const [messages, setMessages] = useState(() => initialMessages)
    const [firstItemIndex, setFirstItemIndex] = useState(0)
    const [height, setHeight] = useState(480)
    const visibleMessages = useMemo(() => filterVisibleMessages(messages), [messages])
    const groupedMessages = useMemo(() => groupChatRows(messages, visibleMessages), [messages, visibleMessages])
    const chatState = useChatState(messages, "scroll-regression-fixture")
    const scroll = useScrollBehavior(
        messages,
        visibleMessages,
        groupedMessages,
        chatState.expandedRows,
        chatState.setExpandedRows,
    )
    const context = useMemo(
        () => ({
            ...base,
            taskViewState: {
                taskId: "scroll-regression-fixture",
                taskInstanceId: "story-opening",
                phase: "idle" as const,
                stateRevision: 0,
                input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
                footer: { actions: [] },
            },
            clineMessages: messages,
            setClineMessages: setMessages,
            firstItemIndex,
            setFirstItemIndex,
            totalMessageCount: messages.length,
        }),
        [base, firstItemIndex, messages],
    )

    useEffect(() => {
        const original = TaskServiceClient.fetchMessage
        TaskServiceClient.fetchMessage = async ({ referenceIndex, count, taskId, taskInstanceId }) => {
            const startIndex = referenceIndex < 0 ? Math.max(0, messages.length - count) : referenceIndex
            return {
                messages: messages.slice(startIndex, startIndex + count).map(convertClineMessageToProto),
                startIndex,
                totalCount: messages.length,
                taskId,
                taskInstanceId,
            }
        }
        return () => {
            TaskServiceClient.fetchMessage = original
        }
    }, [messages])

    const appendCompletion = (text: string) => {
        setMessages((prev) => [...prev, { ts: (prev.at(-1)?.ts ?? 1) + 1, type: "say", say: "completion_result", text }])
    }
    const updateTail = () => {
        setMessages((prev) =>
            prev.map((message, index) =>
                index === prev.length - 1 ? { ...message, text: `${message.text}\n\nSCROLL_UPDATED_TAIL` } : message,
            ),
        )
    }

    return (
        <ExtensionStateContext.Provider value={context}>
            <div style={{ width: 500 }}>
                <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setMessages((prev) => prev.map((message) => ({ ...message })))} type="button">
                        Refresh messages
                    </button>
                    <button onClick={() => setHeight((prev) => (prev === 480 ? 280 : 480))} type="button">
                        Resize viewport
                    </button>
                    <button onClick={() => appendCompletion("SCROLL_COMPLETION_CARD")} type="button">
                        Append completion
                    </button>
                    <button onClick={updateTail} type="button">
                        Update tail
                    </button>
                    <button onClick={() => appendCompletion("Long tool content\n\n".repeat(100))} type="button">
                        Append long card
                    </button>
                </div>
                <div data-testid="scroll-fixture" style={{ height }}>
                    <MessagesArea
                        chatState={chatState}
                        groupedMessages={groupedMessages}
                        messageHandlers={HANDLERS}
                        modifiedMessages={messages}
                        onFollowupOptionSelect={selectOption}
                        scrollBehavior={scroll}
                        task={TASK}
                    />
                </div>
            </div>
        </ExtensionStateContext.Provider>
    )
}

const meta: Meta<typeof ScrollFixture> = {
    title: "Regression/Message Scrolling",
    component: ScrollFixture,
    parameters: { layout: "fullscreen" },
}
export default meta
type Story = StoryObj<typeof ScrollFixture>
export const Interactive: Story = {}
export const LongReportTail: Story = {
    args: { initialMessages: [...INITIAL_MESSAGES, LONG_REPORT] },
}
