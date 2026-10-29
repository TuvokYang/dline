import type { UiMessage } from "@shared/ExtensionMessage"
import { TrajectoryState, TrajectoryTurnSummary, TrajectoryUpdate } from "@shared/proto/dline/task"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getTaskViewKey } from "@/services/task-messages"
import { useChatState } from "../../hooks/useChatState"
import { useScrollBehavior } from "../../hooks/useScrollBehavior"
import type { ChatState, FoldExpansion, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { groupChatRows } from "../../utils/messageUtils"
import {
    checkOutFileTree,
    discardedRequests,
    multiTurnTranscript,
    twoTurnTranscript,
    userFeedback,
} from "../messages/activityFoldStoryFixtures"
import { MessagesArea } from "./MessagesArea"

interface VirtuosoTestProps {
    atBottomStateChange?: (atBottom: boolean) => void
    initialTopMostItemIndex?: number | { index: number; align: "end" | "start" | "center" }
    rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
    scrollerRef?: (element: HTMLElement | Window | null) => void
    data?: readonly unknown[]
    firstItemIndex?: number
    itemContent?: (index: number, item: unknown) => React.ReactNode
    computeItemKey?: (index: number, item: unknown) => React.Key
}

const mocks = vi.hoisted(() => ({
    fetchMessage: vi.fn(),
    initialMessages: [] as UiMessage[],
    initialFirstItemIndex: 0,
    totalMessageCount: 0,
    currentMessages: [] as UiMessage[],
    currentFirstItemIndex: 0,
    setCurrentMessages: undefined as React.Dispatch<React.SetStateAction<UiMessage[]>> | undefined,
    virtuosoProps: undefined as VirtuosoTestProps | undefined,
    scrollToIndex: vi.fn(),
    /** Row wrappers the mock list renders; zero keeps the scroller detached. */
    renderedRowCount: 0,
    /** Draw MessagesArea's own `data` through its `itemContent` instead of synthetic rows. */
    renderItems: false,
    /** The hook instance that publishes the held window; rows drawn inside the list read the state too. */
    windowOwner: undefined as symbol | undefined,
    /** Timestamp of the message the first rendered row shows. */
    firstRenderedTs: 0,
    taskInstanceId: "task-instance-1",
    trajectoryStreams: [] as Array<{ onResponse: (update: TrajectoryUpdate) => void }>,
    /** Records every renderer factory call so tests can read what MessagesArea handed it. */
    createMessageRenderer: vi.fn(
        (..._args: unknown[]) =>
            () =>
                null,
    ),
}))

vi.mock("@/context/ExtensionStateContext", async () => {
    const ReactModule = await import("react")

    return {
        useExtensionState: () => {
            const [clineMessages, setClineMessages] = ReactModule.useState(() => mocks.initialMessages)
            const [firstItemIndex, setFirstItemIndex] = ReactModule.useState(mocks.initialFirstItemIndex)
            const [instance] = ReactModule.useState(() => Symbol("extension-state"))
            mocks.windowOwner ??= instance

            if (mocks.windowOwner === instance) {
                mocks.currentMessages = clineMessages
                mocks.currentFirstItemIndex = firstItemIndex
                mocks.setCurrentMessages = setClineMessages
            }

            return {
                mode: "act",
                clineMessages,
                setClineMessages,
                totalMessageCount: mocks.totalMessageCount,
                firstItemIndex,
                setFirstItemIndex,
                taskViewState: { taskId: "task-1", taskInstanceId: mocks.taskInstanceId },
            }
        },
    }
})

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: { openFileRelativePath: vi.fn(() => Promise.resolve()) },
    TaskServiceClient: {
        fetchMessage: mocks.fetchMessage,
        subscribeToTrajectory: (_request: unknown, callbacks: { onResponse: (update: TrajectoryUpdate) => void }) => {
            mocks.trajectoryStreams.push(callbacks)
            return () => undefined
        },
    },
}))

vi.mock("@shared/proto-conversions/cline-message", () => ({
    convertProtoToClineMessage: (message: UiMessage) => message,
}))

vi.mock("react-virtuoso", async () => {
    const ReactModule = await import("react")
    const Virtuoso = ReactModule.forwardRef<unknown, VirtuosoTestProps>((props, ref) => {
        mocks.virtuosoProps = props
        ReactModule.useImperativeHandle(ref, () => ({
            scrollToIndex: mocks.scrollToIndex,
        }))
        const { scrollerRef } = props
        const attachScroller = ReactModule.useCallback(
            (element: HTMLDivElement | null) => {
                if (mocks.renderedRowCount > 0 || mocks.renderItems) scrollerRef?.(element)
            },
            [scrollerRef],
        )
        // Item wrappers carry the same attributes the real list renders:
        // `data-index` is the position in `data`, `data-item-index` the public
        // index, and the message row inside renders `data-message-ts`.
        const firstItemIndex = props.firstItemIndex ?? 0
        const rows = mocks.renderItems
            ? (props.data ?? []).map((item, index) =>
                  ReactModule.createElement(
                      "div",
                      {
                          key: props.computeItemKey?.(firstItemIndex + index, item) ?? index,
                          "data-index": index,
                          "data-item-index": firstItemIndex + index,
                      },
                      props.itemContent?.(firstItemIndex + index, item),
                  ),
              )
            : Array.from({ length: mocks.renderedRowCount }, (_, index) =>
                  ReactModule.createElement(
                      "div",
                      { key: index, "data-index": index, "data-item-index": index + 1000 },
                      ReactModule.createElement("div", {
                          "data-message-ts": mocks.firstRenderedTs + index,
                          "data-row-ts": mocks.firstRenderedTs + index,
                      }),
                  ),
              )
        return ReactModule.createElement(
            "div",
            { "data-testid": "virtuoso", "data-virtuoso-scroller": "true", ref: attachScroller },
            ...rows,
        )
    })

    return { Virtuoso }
})

vi.mock("@/components/chat/task-header/StickyUserMessage", () => ({
    StickyUserMessage: ({ isVisible, onScrollToMessage }: { isVisible: boolean; onScrollToMessage: () => void }) =>
        isVisible ? (
            <button aria-label="Sticky user message" onClick={onScrollToMessage} type="button">
                Sticky user message
            </button>
        ) : null,
}))

vi.mock("../messages/MessageRenderer", () => ({
    createMessageRenderer: (...args: unknown[]) => mocks.createMessageRenderer(...args),
}))

// Leaves of the real renderer, which the folded-list harness draws.
vi.mock("@/components/chat/ChatRow", () => ({
    default: ({ message }: { message: UiMessage }) => <div data-chat-row-ts={message.ts} />,
}))

vi.mock("../messages/CheckpointMarker", () => ({
    CheckpointMarker: ({ message }: { message: UiMessage }) => <div data-testid="checkpoint" data-ts={message.ts} />,
}))

beforeEach(() => {
    mocks.windowOwner = undefined
})

/** Position of the fold expansion argument in `createMessageRenderer`'s signature. */
const FOLD_EXPANSION_ARGUMENT = 10

function createMessages(startIndex: number, count: number): UiMessage[] {
    return Array.from({ length: count }, (_, offset) => {
        const absoluteIndex = startIndex + offset
        return {
            ts: absoluteIndex + 1,
            type: "say",
            say: "text",
            text: `message-${absoluteIndex}`,
        } as UiMessage
    })
}

function createScrollBehavior(): ScrollBehavior {
    return {
        virtuosoRef: React.createRef(),
        scrollContainerRef: React.createRef(),
        disableAutoScrollRef: { current: false },
        isAtBottomRef: { current: true },
        absoluteBottomLoadedRef: { current: true },
        requestProgrammaticScroll: vi.fn(),
        cancelProgrammaticScroll: vi.fn(),
        scrollToBottomSmooth: vi.fn(),
        scrollToBottomAuto: vi.fn(),
        scrollToMessage: vi.fn(),
        toggleRowExpansion: vi.fn(),
        toggleFoldExpansion: vi.fn(),
        handleRowHeightChange: vi.fn(),
        showScrollToBottom: false,
        setShowScrollToBottom: vi.fn(),
        isAtBottom: true,
        setIsAtBottom: vi.fn(),
        pendingScrollToMessage: null,
        setPendingScrollToMessage: vi.fn(),
        scrolledPastUserMessage: null,
        handleRangeChanged: vi.fn(),
    }
}

function messagesAreaElement(scrollBehavior: ScrollBehavior, messages: UiMessage[]) {
    const task = messages[0] ?? createMessages(0, 1)[0]
    return (
        <MessagesArea
            chatState={
                {
                    expandedRows: {},
                    expandedFolds: {},
                    setActiveQuote: vi.fn(),
                    setInputValue: vi.fn(),
                } as unknown as ChatState
            }
            groupedMessages={messages}
            messageHandlers={{ handleSendMessage: vi.fn() } as unknown as MessageHandlers}
            modifiedMessages={messages}
            onFollowupOptionSelect={vi.fn()}
            scrollBehavior={scrollBehavior}
            task={task}
        />
    )
}

function renderMessagesArea(scrollBehavior = createScrollBehavior()) {
    render(messagesAreaElement(scrollBehavior, mocks.initialMessages))
    return scrollBehavior
}

describe("MessagesArea sliding-window integration", () => {
    beforeEach(() => {
        mocks.fetchMessage.mockReset()
        mocks.scrollToIndex.mockReset()
        mocks.virtuosoProps = undefined
        mocks.initialMessages = createMessages(300, 400)
        mocks.initialFirstItemIndex = 300
        mocks.totalMessageCount = 1000
        mocks.currentMessages = []
        mocks.currentFirstItemIndex = 0
        mocks.setCurrentMessages = undefined
        mocks.renderedRowCount = 0
        mocks.firstRenderedTs = 0
        mocks.taskInstanceId = "task-instance-1"
        mocks.trajectoryStreams = []
    })

    afterEach(() => {
        cleanup()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it("keeps the sticky overlay transparent outside the visible message", () => {
        const scrollBehavior = createScrollBehavior()
        scrollBehavior.scrolledPastUserMessage = createMessages(0, 1)[0]
        renderMessagesArea(scrollBehavior)

        const stickyMessage = screen.getByRole("button", { name: "Sticky user message" })
        expect(stickyMessage.parentElement).toHaveClass("pointer-events-none")
    })

    it("initializes a loaded tail at the absolute bottom without a visible retry chain", () => {
        mocks.initialMessages = createMessages(800, 200)
        mocks.initialFirstItemIndex = 800
        mocks.totalMessageCount = 1000
        const scrollBehavior = renderMessagesArea()

        expect(mocks.virtuosoProps?.initialTopMostItemIndex).toEqual({ index: 199, align: "end" })
        expect(scrollBehavior.requestProgrammaticScroll).not.toHaveBeenCalled()
    })

    it("re-follows the loaded bottom when a completion say becomes an ask with the same timestamp and text", async () => {
        const completionText = "Completion is ready"
        mocks.initialMessages = [
            createMessages(0, 1)[0],
            {
                ts: 2,
                type: "say",
                say: "completion_result",
                text: completionText,
                partial: false,
            } as UiMessage,
        ]
        mocks.initialFirstItemIndex = 0
        mocks.totalMessageCount = 2
        const scrollBehavior = renderMessagesArea()

        act(() => {
            mocks.setCurrentMessages?.((messages) => [
                ...messages.slice(0, -1),
                {
                    ...messages.at(-1)!,
                    type: "ask",
                    ask: "completion_result",
                    say: undefined,
                    interactionId: "completion-interaction",
                },
            ])
        })

        await waitFor(() => {
            expect(scrollBehavior.requestProgrammaticScroll).toHaveBeenCalledWith(
                expect.objectContaining({
                    priority: "layout",
                    retryDelaysMs: [50, 200, 500],
                }),
            )
        })
    })

    it("does not lose a boundary fetch when two ranges arrive within the old throttle window", async () => {
        mocks.fetchMessage.mockResolvedValue({
            messages: [],
            startIndex: 0,
            taskId: "task-1",
            taskInstanceId: "task-instance-1",
        })
        const scrollBehavior = createScrollBehavior()
        renderMessagesArea(scrollBehavior)
        fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 })

        act(() => {
            mocks.virtuosoProps?.rangeChanged({ startIndex: 150, endIndex: 250 })
            mocks.virtuosoProps?.rangeChanged({ startIndex: 0, endIndex: 20 })
        })

        await waitFor(() => {
            expect(mocks.fetchMessage).toHaveBeenCalledTimes(1)
        })
        expect(mocks.fetchMessage.mock.calls[0][0]).toMatchObject({ referenceIndex: 100, count: 200 })
    })

    it("replans after a merge when the viewport remains inside the extension threshold", async () => {
        mocks.initialMessages = createMessages(300, 250)
        mocks.initialFirstItemIndex = 300
        mocks.fetchMessage
            .mockResolvedValueOnce({
                messages: createMessages(250, 50),
                startIndex: 250,
                taskId: "task-1",
                taskInstanceId: "task-instance-1",
            })
            .mockResolvedValueOnce({
                messages: [],
                startIndex: 50,
                taskId: "task-1",
                taskInstanceId: "task-instance-1",
            })
        const scrollBehavior = createScrollBehavior()
        renderMessagesArea(scrollBehavior)
        fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 })

        act(() => {
            mocks.virtuosoProps?.rangeChanged({ startIndex: 0, endIndex: 20 })
        })

        await waitFor(() => {
            expect(mocks.fetchMessage).toHaveBeenCalledTimes(2)
        })
        expect(mocks.fetchMessage.mock.calls[0][0]).toMatchObject({ referenceIndex: 100, count: 200 })
        expect(mocks.fetchMessage.mock.calls[1][0]).toMatchObject({ referenceIndex: 50, count: 200 })
    })

    it("reaches a reply that arrived below the loaded window while following the bottom", async () => {
        // The window stops one message short of the conversation, which is what a
        // new reply looks like before it has been fetched.
        mocks.initialMessages = createMessages(800, 200)
        mocks.initialFirstItemIndex = 800
        mocks.totalMessageCount = 1001
        mocks.fetchMessage.mockResolvedValue({ messages: createMessages(1000, 1), startIndex: 1000 })
        renderMessagesArea()

        // Reported ranges are absolute row indexes and are clamped to the loaded
        // rows, so this is "the viewport sits on the last loaded row".
        act(() => {
            mocks.virtuosoProps?.rangeChanged({ startIndex: Number.MAX_SAFE_INTEGER, endIndex: Number.MAX_SAFE_INTEGER })
        })

        // Withholding this fetch is self-defeating: an unloaded tail is exactly
        // what suppresses the follow intent, so the reply would stay outside both
        // the window and the view for the rest of the task.
        await waitFor(() => {
            expect(mocks.fetchMessage).toHaveBeenCalledTimes(1)
        })
        expect(mocks.fetchMessage.mock.calls[0][0]).toMatchObject({ referenceIndex: 1000, count: 1 })
    })

    it("still refuses to page history while following the bottom", async () => {
        // Same viewport, but the leading side is the one short of the edge. Paging
        // there on every layout event would eagerly pull in the whole transcript.
        mocks.initialMessages = createMessages(800, 200)
        mocks.initialFirstItemIndex = 800
        mocks.totalMessageCount = 1000
        mocks.fetchMessage.mockResolvedValue({ messages: [], startIndex: 600 })
        renderMessagesArea()

        act(() => {
            mocks.virtuosoProps?.rangeChanged({ startIndex: 800, endIndex: 820 })
        })

        await act(async () => {
            await Promise.resolve()
        })
        expect(mocks.fetchMessage).not.toHaveBeenCalled()
    })

    it("keeps the row the reader can see in place when older history merges in ahead of it", async () => {
        // The rendered range Virtuoso reports includes overscan above the
        // viewport. Aligning its first row to the top after the merge pushed the
        // rows the reader was looking at out of view. The restore must target the
        // first row that intersects the viewport, at the offset it had.
        const viewport = { top: 100, height: 500 }
        const rowHeight = 50
        // Row 5 is the first one on screen and starts 20px above the viewport top.
        const rowTop = (index: number) => viewport.top - 20 + (index - 5) * rowHeight
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            const box =
                this.dataset.testid === "virtuoso"
                    ? viewport
                    : this.dataset.itemIndex !== undefined
                      ? { top: rowTop(Number(this.dataset.index)), height: rowHeight }
                      : { top: 0, height: 0 }
            return {
                top: box.top,
                bottom: box.top + box.height,
                height: box.height,
                left: 0,
                right: 300,
                width: 300,
                x: 0,
                y: box.top,
                toJSON: () => ({}),
            }
        })
        mocks.renderedRowCount = 21
        // The rendered band starts at the first loaded message (ts 301), so row 5 shows ts 306.
        mocks.firstRenderedTs = 301
        mocks.initialMessages = createMessages(300, 250)
        mocks.initialFirstItemIndex = 300
        mocks.fetchMessage
            .mockResolvedValueOnce({
                messages: createMessages(250, 50),
                startIndex: 250,
                taskId: "task-1",
                taskInstanceId: "task-instance-1",
            })
            .mockResolvedValue({
                messages: [],
                startIndex: 50,
                taskId: "task-1",
                taskInstanceId: "task-instance-1",
            })
        renderMessagesArea()
        fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 })

        act(() => {
            mocks.virtuosoProps?.rangeChanged({ startIndex: 0, endIndex: 20 })
        })

        // The second request is planned from the merged window, so seeing it
        // proves the first merge has been committed and rendered.
        await waitFor(() => {
            expect(mocks.fetchMessage).toHaveBeenCalledTimes(2)
        })
        // This harness passes fixed grouped rows, so the anchored row keeps its
        // position in `data`; what matters is that it is the visible row, not
        // the overscan row at index 0, and that its cut-off is preserved.
        expect(mocks.scrollToIndex).toHaveBeenCalledTimes(1)
        expect(mocks.scrollToIndex).toHaveBeenCalledWith({ index: 5, align: "start", behavior: "auto", offset: 20 })
    })

    it("does not claim session scrolling while a nested card can consume the wheel", () => {
        mocks.initialMessages = createMessages(800, 200)
        mocks.initialFirstItemIndex = 800
        mocks.totalMessageCount = 1000
        const scrollBehavior = renderMessagesArea()
        const innerScroller = document.createElement("div")
        innerScroller.style.overflowY = "auto"
        Object.defineProperties(innerScroller, {
            scrollHeight: { configurable: true, value: 1000 },
            clientHeight: { configurable: true, value: 200 },
            scrollTop: { configurable: true, value: 300, writable: true },
        })
        screen.getByTestId("virtuoso").append(innerScroller)
        const cancellationsBeforeWheel = vi.mocked(scrollBehavior.cancelProgrammaticScroll).mock.calls.length

        fireEvent.wheel(innerScroller, { deltaY: -100 })

        expect(scrollBehavior.disableAutoScrollRef.current).toBe(false)
        expect(vi.mocked(scrollBehavior.cancelProgrammaticScroll).mock.calls.length).toBe(cancellationsBeforeWheel)
    })

    it("does not surrender browsing ownership to a transient at-bottom report", () => {
        mocks.initialMessages = createMessages(800, 200)
        mocks.initialFirstItemIndex = 800
        mocks.totalMessageCount = 1000
        const scrollBehavior = renderMessagesArea()

        fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 })
        expect(scrollBehavior.disableAutoScrollRef.current).toBe(true)

        act(() => {
            mocks.virtuosoProps?.atBottomStateChange?.(true)
        })

        expect(scrollBehavior.disableAutoScrollRef.current).toBe(true)
    })

    it("reports whether the loaded window reaches the end of the conversation", () => {
        // Virtuoso only knows the rows it holds. Sitting at the bottom of a
        // paged window is not the same as sitting at the end of the
        // conversation, and bottom restoration has to be able to tell them
        // apart before it moves the reader.
        mocks.initialMessages = createMessages(800, 200)
        mocks.initialFirstItemIndex = 800
        mocks.totalMessageCount = 1000
        const loadedToEnd = renderMessagesArea()

        act(() => {
            mocks.virtuosoProps?.atBottomStateChange?.(true)
        })
        expect(loadedToEnd.absoluteBottomLoadedRef.current).toBe(true)

        cleanup()

        // Same rows, but the conversation continues past them.
        mocks.initialMessages = createMessages(800, 200)
        mocks.initialFirstItemIndex = 800
        mocks.totalMessageCount = 2000
        const loadedMidway = renderMessagesArea()

        act(() => {
            mocks.virtuosoProps?.atBottomStateChange?.(true)
        })
        expect(loadedMidway.absoluteBottomLoadedRef.current).toBe(false)
    })

    it("does not preload leading history while auto-follow is active", () => {
        mocks.fetchMessage.mockResolvedValue({ messages: [], startIndex: 0 })
        renderMessagesArea()

        act(() => {
            mocks.virtuosoProps?.rangeChanged({ startIndex: 0, endIndex: 20 })
        })

        expect(mocks.fetchMessage).not.toHaveBeenCalled()
    })

    it("keeps the loaded window stable after scrolling becomes idle", () => {
        vi.useFakeTimers()
        mocks.initialMessages = createMessages(100, 700)
        mocks.initialFirstItemIndex = 100
        mocks.totalMessageCount = 2000
        renderMessagesArea()

        act(() => {
            vi.advanceTimersByTime(16)
            mocks.virtuosoProps?.rangeChanged({ startIndex: 400, endIndex: 450 })
        })

        fireEvent.scroll(screen.getByTestId("virtuoso"))

        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        expect(mocks.currentFirstItemIndex).toBe(100)
        expect(mocks.currentMessages).toHaveLength(700)
    })

    describe("trajectory jumps", () => {
        type ScrollRequest = { run: () => void; priority?: string; retryDelaysMs?: readonly number[] }

        /** Render like ChatView: `regroup` hands the list the rows of its current window, as regrouping does. */
        const renderJumpArea = (overrides: Partial<ScrollBehavior> = {}) => {
            const scrollBehavior = { ...createScrollBehavior(), ...overrides }
            const { rerender } = render(messagesAreaElement(scrollBehavior, mocks.initialMessages))
            const regroup = () => rerender(messagesAreaElement(scrollBehavior, mocks.currentMessages))
            const scrollRequests = () =>
                vi.mocked(scrollBehavior.requestProgrammaticScroll).mock.calls.map(([request]) => request as ScrollRequest)
            return { scrollBehavior, regroup, scrollRequests }
        }

        const page = (messages: UiMessage[], anchorFound = true) => ({
            messages,
            startIndex: messages.length > 0 ? messages[0].ts - 1 : 0,
            anchorFound,
            taskId: "task-1",
            taskInstanceId: "task-instance-1",
        })

        const deferredPage = () => {
            let resolve: (value: ReturnType<typeof page>) => void = () => undefined
            mocks.fetchMessage.mockImplementationOnce(
                () =>
                    new Promise((settle) => {
                        resolve = settle
                    }),
            )
            return (value: ReturnType<typeof page>) => act(async () => resolve(value))
        }

        const showTrajectory = (anchors: number[]) =>
            act(() => {
                for (const stream of mocks.trajectoryStreams) {
                    stream.onResponse(
                        TrajectoryUpdate.create({
                            taskId: "task-1",
                            taskInstanceId: mocks.taskInstanceId,
                            state: TrajectoryState.TRAJECTORY_STATE_READY,
                            reset: true,
                            revision: 1,
                            turnCount: anchors.length,
                            turns: anchors.map((anchorTs, seq) =>
                                TrajectoryTurnSummary.create({ seq, anchorTs, prompt: `prompt ${anchorTs}`, rounds: 1 }),
                            ),
                        }),
                    )
                }
            })

        const clickTurn = (anchorTs: number) =>
            act(async () => {
                const bar = document.querySelector(`[data-turn-ts="${anchorTs}"]`)
                if (!bar) throw new Error(`no trajectory bar for ${anchorTs}`)
                fireEvent.click(bar)
            })

        it("scrolls smoothly to a loaded turn whose row is laid out and leaves bottom-following", async () => {
            mocks.renderedRowCount = 10
            mocks.firstRenderedTs = 345
            const { scrollBehavior, scrollRequests } = renderJumpArea()
            showTrajectory([301, 350])

            await clickTurn(350)

            expect(mocks.fetchMessage).not.toHaveBeenCalled()
            expect(scrollBehavior.disableAutoScrollRef.current).toBe(true)
            const request = scrollRequests().at(-1)
            expect(request?.priority).toBe("user")
            request?.run()
            expect(mocks.scrollToIndex).toHaveBeenLastCalledWith(
                expect.objectContaining({ index: 49, align: "start", behavior: "smooth" }),
            )
        })

        it("jumps to a loaded turn whose row is not laid out and keeps re-targeting while rows are measured", async () => {
            mocks.renderedRowCount = 10
            mocks.firstRenderedTs = 380
            const { scrollRequests } = renderJumpArea()
            showTrajectory([301, 350])

            await clickTurn(350)

            expect(mocks.fetchMessage).not.toHaveBeenCalled()
            const request = scrollRequests().at(-1)
            expect(request?.priority).toBe("layout")
            expect(request?.retryDelaysMs?.length).toBeGreaterThan(0)
            request?.run()
            expect(mocks.scrollToIndex).toHaveBeenLastCalledWith(
                expect.objectContaining({ index: 49, align: "start", behavior: "auto" }),
            )
        })

        it("replaces the window with a page centred on an unloaded turn and scrolls to it once laid out", async () => {
            mocks.fetchMessage.mockResolvedValueOnce(page(createMessages(0, 200)))
            const { regroup, scrollRequests } = renderJumpArea()
            showTrajectory([1, 50, 350])

            await clickTurn(50)

            expect(mocks.fetchMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ anchorTs: 50 }))
            await waitFor(() => expect(mocks.currentFirstItemIndex).toBe(0))
            expect(mocks.currentMessages.map((message) => message.ts)).toEqual(createMessages(0, 200).map(({ ts }) => ts))
            // The rows on screen still belong to the old window, so nothing may scroll yet.
            expect(scrollRequests()).toEqual([])

            regroup()

            const request = scrollRequests().at(-1)
            expect(request).toMatchObject({ priority: "layout", retryDelaysMs: [50, 200, 500] })
            request?.run()
            expect(mocks.scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({ index: 49, align: "start" }))
        })

        it("never replaces the window when a loaded turn is clicked while an unloaded jump is fetching", async () => {
            const resolveJump = deferredPage()
            renderJumpArea()
            showTrajectory([50, 350])

            await clickTurn(50)
            await clickTurn(350)
            await resolveJump(page(createMessages(0, 200)))

            expect(mocks.currentFirstItemIndex).toBe(300)
            expect(mocks.currentMessages[0]?.ts).toBe(301)
        })

        it("lets the sticky user message supersede a rail jump that is still fetching", async () => {
            const resolveJump = deferredPage()
            const stickyMessage = mocks.initialMessages.find((message) => message.ts === 350)
            const { scrollRequests } = renderJumpArea({ scrolledPastUserMessage: stickyMessage ?? null })
            showTrajectory([50, 350])

            await clickTurn(50)
            await act(async () => {
                fireEvent.click(screen.getByRole("button", { name: "Sticky user message" }))
            })
            await resolveJump(page(createMessages(0, 200)))

            // The rail's page arrived after the sticky navigation, so it must not replace the window.
            expect(mocks.currentFirstItemIndex).toBe(300)
            expect(mocks.currentMessages[0]?.ts).toBe(301)
            scrollRequests().at(-1)?.run()
            expect(mocks.scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({ index: 49, align: "center" }))
        })

        it("keeps the window and the position when the anchor was removed before the fetch", async () => {
            mocks.fetchMessage.mockResolvedValueOnce(page([], false))
            const { regroup, scrollRequests } = renderJumpArea()
            showTrajectory([50, 350])

            await clickTurn(50)
            regroup()

            expect(mocks.currentFirstItemIndex).toBe(300)
            expect(scrollRequests()).toEqual([])
        })

        it("admits no paging while the replacement is pending and pages the new window once it lands", async () => {
            const resolveJump = deferredPage()
            const { regroup } = renderJumpArea()
            showTrajectory([50, 350])

            await clickTurn(50)
            act(() => {
                mocks.virtuosoProps?.rangeChanged?.({ startIndex: 0, endIndex: 20 })
            })
            await act(async () => {
                await Promise.resolve()
            })
            expect(mocks.fetchMessage).toHaveBeenCalledTimes(1)

            mocks.fetchMessage.mockResolvedValue(page(createMessages(200, 200)))
            await resolveJump(page(createMessages(0, 200)))
            regroup()
            act(() => {
                mocks.virtuosoProps?.rangeChanged?.({ startIndex: Number.MAX_SAFE_INTEGER, endIndex: Number.MAX_SAFE_INTEGER })
            })

            // The first page after the jump extends the window the jump installed.
            await waitFor(() => expect(mocks.fetchMessage.mock.calls.length).toBeGreaterThan(1))
            expect(mocks.fetchMessage.mock.calls[1][0]).toMatchObject({ referenceIndex: 200 })
            expect(mocks.fetchMessage.mock.calls[1][0].anchorTs).toBeUndefined()
        })

        it("keeps the settled copy of a row the stream finished while the jump was fetching", async () => {
            mocks.initialMessages = createMessages(800, 200)
            mocks.initialFirstItemIndex = 800
            const resolveJump = deferredPage()
            renderJumpArea()
            showTrajectory([750, 900])

            await clickTurn(750)
            act(() => {
                mocks.setCurrentMessages?.((messages) =>
                    messages.map((message) => (message.ts === 850 ? { ...message, text: "streamed" } : message)),
                )
            })
            // The page was cut while that row was still streaming.
            const snapshot = createMessages(700, 200).map((message) =>
                message.ts === 850 ? { ...message, text: "stre", partial: true } : message,
            )
            await resolveJump(page(snapshot))

            expect(mocks.currentFirstItemIndex).toBe(700)
            expect(mocks.currentMessages.find((message) => message.ts === 850)?.text).toBe("streamed")
        })

        it("drops a jump whose page arrives after the task was reopened", async () => {
            const resolveJump = deferredPage()
            renderJumpArea()
            showTrajectory([50, 350])

            await clickTurn(50)
            mocks.taskInstanceId = "task-instance-2"
            act(() => {
                mocks.setCurrentMessages?.((messages) => [...messages])
            })
            await resolveJump(page(createMessages(0, 200)))

            expect(mocks.currentFirstItemIndex).toBe(300)
        })

        it("does not pull the view back to the bottom when a reply arrives after a jump", async () => {
            mocks.initialMessages = createMessages(800, 200)
            mocks.initialFirstItemIndex = 800
            const { scrollRequests } = renderJumpArea()
            showTrajectory([850, 950])

            await clickTurn(850)
            const before = scrollRequests().length
            act(() => {
                mocks.setCurrentMessages?.((messages) => [...messages, ...createMessages(1000, 1)])
            })

            expect(scrollRequests()).toHaveLength(before)
        })

        it("lets the leading and trailing pages launched for one window both land", async () => {
            mocks.initialMessages = createMessages(300, 50)
            mocks.initialFirstItemIndex = 300
            mocks.fetchMessage.mockImplementation(async (request: { referenceIndex: number; count: number }) =>
                page(createMessages(request.referenceIndex, request.count)),
            )
            renderMessagesArea()
            fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 })

            act(() => {
                mocks.virtuosoProps?.rangeChanged?.({ startIndex: 0, endIndex: 49 })
            })

            await waitFor(() => expect(mocks.fetchMessage).toHaveBeenCalledTimes(2))
            await waitFor(() => {
                expect(mocks.currentFirstItemIndex).toBeLessThan(300)
                expect(mocks.currentMessages.at(-1)?.ts).toBeGreaterThan(350)
            })
        })
    })
})

describe("MessagesArea fold expansion", () => {
    beforeEach(() => {
        mocks.createMessageRenderer.mockClear()
        mocks.fetchMessage.mockReset()
        mocks.initialMessages = createMessages(0, 3)
        mocks.initialFirstItemIndex = 0
        mocks.totalMessageCount = 3
        mocks.renderedRowCount = 0
        mocks.trajectoryStreams = []
    })

    afterEach(() => {
        cleanup()
    })

    /**
     * Props unrelated to folding, created once per test. Recreating them on each
     * rerender would rebuild the renderer anyway and hide a fold map missing from
     * the memo dependencies.
     */
    function createStableProps() {
        return {
            expandedRows: {},
            setActiveQuote: vi.fn(),
            setInputValue: vi.fn(),
            messageHandlers: { handleSendMessage: vi.fn() } as unknown as MessageHandlers,
            onFollowupOptionSelect: vi.fn(),
        }
    }

    function foldAreaElement(
        scrollBehavior: ScrollBehavior,
        stable: ReturnType<typeof createStableProps>,
        expandedFolds: Record<string, boolean>,
    ) {
        const messages = mocks.initialMessages
        return (
            <MessagesArea
                chatState={
                    {
                        expandedRows: stable.expandedRows,
                        expandedFolds,
                        setActiveQuote: stable.setActiveQuote,
                        setInputValue: stable.setInputValue,
                    } as unknown as ChatState
                }
                groupedMessages={messages}
                messageHandlers={stable.messageHandlers}
                modifiedMessages={messages}
                onFollowupOptionSelect={stable.onFollowupOptionSelect}
                scrollBehavior={scrollBehavior}
                task={messages[0]}
            />
        )
    }

    function latestFoldExpansion(): FoldExpansion {
        const call = mocks.createMessageRenderer.mock.calls.at(-1)
        expect(call).toBeDefined()
        return call?.[FOLD_EXPANSION_ARGUMENT] as FoldExpansion
    }

    it("renders folds from the chat-owned expansion map and routes a header toggle to the scroll behavior", () => {
        const scrollBehavior = createScrollBehavior()
        const stable = createStableProps()
        const openFirst = { "fold:10": true }
        const { rerender } = render(foldAreaElement(scrollBehavior, stable, openFirst))

        expect(latestFoldExpansion().expanded).toEqual({ "fold:10": true })
        latestFoldExpansion().toggle("fold:10")
        expect(scrollBehavior.toggleFoldExpansion).toHaveBeenCalledWith("fold:10")
        expect(scrollBehavior.toggleRowExpansion).not.toHaveBeenCalled()

        // With every input unchanged the renderer is reused, so the next rebuild
        // can only come from the fold map.
        const buildsBefore = mocks.createMessageRenderer.mock.calls.length
        rerender(foldAreaElement(scrollBehavior, stable, openFirst))
        expect(mocks.createMessageRenderer.mock.calls.length).toBe(buildsBefore)

        // Opening a second fold must reach the renderer, or the header would stay closed.
        rerender(foldAreaElement(scrollBehavior, stable, { "fold:10": true, "fold:71": true }))
        expect(mocks.createMessageRenderer.mock.calls.length).toBe(buildsBefore + 1)
        expect(latestFoldExpansion().expanded).toEqual({ "fold:10": true, "fold:71": true })
    })
})

describe("MessagesArea with real folding", () => {
    type ScrollRequest = { run: () => void; priority?: string }

    /**
     * Row of turn 2's user message once turn-level folding has run, listed by
     * hand: 1, turn:10, 53, turn:60, 64, 70. Unfolded it would be row 26.
     */
    const TURN_TWO_FOLDED_ROW = 5
    const TURN_ANCHORS = [1, 70, 90]
    const TURN_THREE_START = multiTurnTranscript.findIndex((message) => message.ts === 90)
    const messageHandlers = { handleSendMessage: vi.fn() } as unknown as MessageHandlers
    const onFollowupOptionSelect = vi.fn()
    const harness = {
        scrollRequests: [] as ScrollRequest[],
        setMessages: undefined as React.Dispatch<React.SetStateAction<UiMessage[]>> | undefined,
    }

    beforeEach(async () => {
        const actual = await vi.importActual<typeof import("../messages/MessageRenderer")>("../messages/MessageRenderer")
        mocks.createMessageRenderer.mockImplementation(actual.createMessageRenderer as (...args: unknown[]) => () => null)
        mocks.renderItems = true
        mocks.renderedRowCount = 0
        mocks.fetchMessage.mockReset()
        mocks.scrollToIndex.mockReset()
        mocks.virtuosoProps = undefined
        mocks.taskInstanceId = "task-instance-1"
        mocks.trajectoryStreams = []
        harness.scrollRequests = []
    })

    afterEach(() => {
        cleanup()
        mocks.renderItems = false
        mocks.createMessageRenderer.mockImplementation(() => () => null)
    })

    /**
     * The chat as ChatView assembles it: turn-level folding of the held rows,
     * with the real chat state keyed by the task opening and the real scroll
     * behavior. Scroll requests are recorded on their way to the real arbiter.
     */
    function FoldedChat({ initial }: { initial: UiMessage[] }) {
        const [messages, setMessages] = React.useState(initial)
        harness.setMessages = setMessages
        const chatState = useChatState(messages, getTaskViewKey({ taskId: "task-1", taskInstanceId: mocks.taskInstanceId }))
        const groupedMessages = React.useMemo(() => groupChatRows(messages, undefined, { level: "turn" }), [messages])
        const scroll = useScrollBehavior(
            messages,
            messages,
            groupedMessages,
            chatState.expandedRows,
            chatState.setExpandedRows,
            chatState.setExpandedFolds,
        )
        const { requestProgrammaticScroll } = scroll
        const recordScroll = React.useCallback(
            (request: Parameters<typeof requestProgrammaticScroll>[0]) => {
                harness.scrollRequests.push(request)
                requestProgrammaticScroll(request)
            },
            [requestProgrammaticScroll],
        )
        return (
            <MessagesArea
                chatState={chatState}
                groupedMessages={groupedMessages}
                messageHandlers={messageHandlers}
                modifiedMessages={messages}
                onFollowupOptionSelect={onFollowupOptionSelect}
                scrollBehavior={{ ...scroll, requestProgrammaticScroll: recordScroll }}
                task={messages[0]}
            />
        )
    }

    function renderChat(messages: UiMessage[], firstItemIndex = 0, total = messages.length) {
        mocks.initialMessages = messages
        mocks.initialFirstItemIndex = firstItemIndex
        mocks.totalMessageCount = total
        return render(<FoldedChat initial={messages} />)
    }

    /** The extension sends the next rows: the held window and the rows ChatView groups both take them. */
    const deliver = (messages: UiMessage[]) =>
        act(() => {
            mocks.totalMessageCount = messages.length
            mocks.setCurrentMessages?.(messages)
            harness.setMessages?.(messages)
        })

    const fold = (foldId: string) => document.querySelector<HTMLElement>(`[data-fold-id="${foldId}"]`)
    const header = (foldId: string) => fold(foldId)?.querySelector<HTMLElement>('[data-testid="activity-fold-header"]')
    const drawnChildren = (foldId: string) =>
        Array.from(
            fold(foldId)?.querySelectorAll<HTMLElement>('[data-testid="activity-fold-children"] [data-message-ts]') ?? [],
        ).map((element) => Number(element.dataset.messageTs))
    const openFold = (foldId: string) =>
        act(() => {
            const button = header(foldId)
            if (!button) throw new Error(`no header for ${foldId}`)
            fireEvent.click(button)
        })

    const withCommand33 = (status: "running" | "completed") =>
        twoTurnTranscript.map((message) =>
            message.ts === 33 ? { ...message, commandStatus: status, exitCode: status === "completed" ? 0 : undefined } : message,
        )

    /** Scrolls the list made to its last row, which is what following the bottom does. */
    const bottomScrolls = () =>
        mocks.scrollToIndex.mock.calls.filter(([location]) => (location as { align?: string }).align === "end").length
    /** Longer than the follow's last layout retry, so a follow that is going to happen has happened. */
    const settleScrolls = () => act(() => new Promise((resolve) => setTimeout(resolve, 700)))

    it("stops following the bottom once the reader opens a fold, and grows that open fold in place", async () => {
        const running = withCommand33("running")
        renderChat(running)
        // The running command 33 is live, so turn 1 folds only its rounds before it.
        expect(drawnChildren("turn:10")).toEqual([])

        // While nothing is open, new output is followed to the bottom.
        await settleScrolls()
        let scrolls = bottomScrolls()
        const followed = [...running, userFeedback(50, "Now the tokens.")]
        deliver(followed)
        await waitFor(() => expect(bottomScrolls()).toBeGreaterThan(scrolls))
        await settleScrolls()

        // Opening the turn fold and its last round does not jump the list to the bottom.
        scrolls = bottomScrolls()
        openFold("turn:10")
        openFold("fold:30")
        await settleScrolls()
        expect(bottomScrolls()).toBe(scrolls)
        expect(header("turn:10")).toHaveAttribute("aria-expanded", "true")
        expect(header("fold:30")).toHaveAttribute("aria-expanded", "true")
        const openTurn = fold("turn:10")
        const openRound = fold("fold:30")

        // Once the reader opened a fold, new output is no longer followed.
        const grown = [...followed, userFeedback(51, "And the parser tests.")]
        deliver(grown)
        await settleScrolls()
        expect(bottomScrolls()).toBe(scrolls)

        // The background command finishes: the same open round of the same open turn takes it in.
        expect(drawnChildren("turn:10")).toEqual([30, 32])
        deliver(grown.map((message) => (message.ts === 33 ? { ...message, commandStatus: "completed", exitCode: 0 } : message)))
        expect(fold("turn:10")).toBe(openTurn)
        expect(fold("fold:30")).toBe(openRound)
        expect(header("turn:10")).toHaveAttribute("aria-expanded", "true")
        expect(header("fold:30")).toHaveAttribute("aria-expanded", "true")
        expect(drawnChildren("turn:10")).toEqual([30, 32, 33])
    })

    it("keeps an open fold open, with its remaining members, through a workspace restore", () => {
        renderChat(withCommand33("completed"))
        openFold("turn:10")
        openFold("fold:10")
        openFold("fold:30")
        expect(drawnChildren("turn:10")).toEqual([10, 12, 30, 32, 33])

        // A workspace restore keeps the opening and its rows; only the checkout markers change.
        deliver(checkOutFileTree(withCommand33("completed"), "tree-b"))

        // The checked-out restore point 20 cuts turn 1: its first round stays open in place,
        // and the rounds after the cut move to a turn fold of their own, folded.
        expect(header("turn:10")).toHaveAttribute("aria-expanded", "true")
        expect(drawnChildren("turn:10")).toEqual([10, 12])
        expect(header("turn:22")).toHaveAttribute("aria-expanded", "false")
        expect(drawnChildren("turn:22")).toEqual([])
        expect(document.querySelector('[data-row-ts="20"] [data-message-ts="20"]')).not.toBeNull()
    })

    it("starts the reopened task after a chat restore with every fold collapsed", () => {
        const held = withCommand33("completed")
        renderChat(held)
        openFold("turn:10")
        openFold("fold:10")
        expect(drawnChildren("turn:10")).toEqual([10, 12])

        // Editing the second message restores the task only: the chat keeps the
        // rows through 35, records the discarded requests, says the edited text
        // again and reopens the task. Turn 1 keeps its end, so turn:10 exists again.
        const kept = held.slice(0, held.findIndex(({ ts }) => ts === 35) + 1)
        mocks.taskInstanceId = "task-instance-2"
        deliver([...kept, discardedRequests(100), userFeedback(101, "Split the lexer and its tokens.")])

        expect(fold("turn:10")).not.toBeNull()
        expect(header("turn:10")).toHaveAttribute("aria-expanded", "false")
        expect(drawnChildren("turn:10")).toEqual([])
        expect(document.querySelector('[data-row-ts="101"] [data-message-ts="101"]')).not.toBeNull()
        expect(document.querySelector('[data-message-ts="100"]')).toBeNull()
    })

    function showTrajectory() {
        act(() => {
            for (const stream of mocks.trajectoryStreams) {
                stream.onResponse(
                    TrajectoryUpdate.create({
                        taskId: "task-1",
                        taskInstanceId: mocks.taskInstanceId,
                        state: TrajectoryState.TRAJECTORY_STATE_READY,
                        reset: true,
                        revision: 1,
                        turnCount: TURN_ANCHORS.length,
                        turns: TURN_ANCHORS.map((anchorTs, seq) =>
                            TrajectoryTurnSummary.create({ seq, anchorTs, prompt: `prompt ${anchorTs}`, rounds: 1 }),
                        ),
                    }),
                )
            }
        })
    }

    const clickTurn = (anchorTs: number) =>
        act(async () => {
            const bar = document.querySelector(`[data-turn-ts="${anchorTs}"]`)
            if (!bar) throw new Error(`no trajectory bar for ${anchorTs}`)
            fireEvent.click(bar)
        })

    /** The drawn item at a data position, which is where a scroll to that index lands. */
    const itemAt = (position: number) => document.querySelector<HTMLElement>(`[data-index="${position}"]`)

    /** The item at `position` exists and is the user's own row, not a fold that holds it. */
    function expectStandaloneUserRowAt(position: number, ts: number) {
        const item = itemAt(position)
        expect(item).not.toBeNull()
        const rowWrapper = item?.querySelector<HTMLElement>("[data-row-ts]") ?? null
        expect(rowWrapper?.getAttribute("data-row-ts") ?? null).toBe(String(ts))
        expect(rowWrapper?.querySelector(`[data-message-ts="${ts}"]`) ?? null).not.toBeNull()
        expect(item?.querySelector("[data-fold-id]") ?? null).toBeNull()
    }

    it("scrolls to the drawn user row of a loaded turn among folds", async () => {
        renderChat(multiTurnTranscript)
        showTrajectory()

        await clickTurn(70)

        expect(mocks.fetchMessage).not.toHaveBeenCalled()
        harness.scrollRequests.at(-1)?.run()
        expect(mocks.scrollToIndex).toHaveBeenLastCalledWith(
            expect.objectContaining({ index: TURN_TWO_FOLDED_ROW, align: "start" }),
        )
        expectStandaloneUserRowAt(TURN_TWO_FOLDED_ROW, 70)
        // turn:10 and turn:60 in turn 1, turn:71 and turn:82 in turn 2; turn 3 has not ended.
        expect(document.querySelectorAll("[data-fold-id]")).toHaveLength(4)
    })

    it("lands on the drawn user row of a turn fetched into a new window", async () => {
        renderChat(multiTurnTranscript.slice(TURN_THREE_START), TURN_THREE_START, multiTurnTranscript.length)
        mocks.fetchMessage.mockResolvedValueOnce({
            messages: multiTurnTranscript,
            startIndex: 0,
            anchorFound: true,
            taskId: "task-1",
            taskInstanceId: "task-instance-1",
        })
        showTrajectory()

        await clickTurn(70)

        expect(mocks.fetchMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ anchorTs: 70 }))
        await waitFor(() => expect(mocks.currentMessages).toHaveLength(multiTurnTranscript.length))
        // ChatView regroups the window it now holds.
        act(() => harness.setMessages?.(mocks.currentMessages))
        harness.scrollRequests.at(-1)?.run()
        expect(mocks.scrollToIndex).toHaveBeenLastCalledWith(
            expect.objectContaining({ index: TURN_TWO_FOLDED_ROW, align: "start" }),
        )
        expectStandaloneUserRowAt(TURN_TWO_FOLDED_ROW, 70)
        expect(document.querySelectorAll("[data-fold-id]")).toHaveLength(4)
    })
})
