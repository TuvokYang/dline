import type { ClineMessage } from "@shared/ExtensionMessage"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { MessagesArea } from "./MessagesArea"

interface VirtuosoTestProps {
	atBottomStateChange?: (atBottom: boolean) => void
	initialTopMostItemIndex?: number | { index: number; align: "end" | "start" | "center" }
	rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
}

const mocks = vi.hoisted(() => ({
	fetchMessage: vi.fn(),
	initialMessages: [] as ClineMessage[],
	initialFirstItemIndex: 0,
	totalMessageCount: 0,
	currentMessages: [] as ClineMessage[],
	currentFirstItemIndex: 0,
	setCurrentMessages: undefined as React.Dispatch<React.SetStateAction<ClineMessage[]>> | undefined,
	virtuosoProps: undefined as VirtuosoTestProps | undefined,
	scrollToIndex: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", async () => {
	const ReactModule = await import("react")

	return {
		useExtensionState: () => {
			const [clineMessages, setClineMessages] = ReactModule.useState(() => mocks.initialMessages)
			const [firstItemIndex, setFirstItemIndex] = ReactModule.useState(mocks.initialFirstItemIndex)

			mocks.currentMessages = clineMessages
			mocks.currentFirstItemIndex = firstItemIndex
			mocks.setCurrentMessages = setClineMessages

			return {
				clineMessages,
				setClineMessages,
				totalMessageCount: mocks.totalMessageCount,
				firstItemIndex,
				setFirstItemIndex,
			}
		},
	}
})

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		fetchMessage: mocks.fetchMessage,
	},
}))

vi.mock("@shared/proto-conversions/cline-message", () => ({
	convertProtoToClineMessage: (message: ClineMessage) => message,
}))

vi.mock("react-virtuoso", async () => {
	const ReactModule = await import("react")
	const Virtuoso = ReactModule.forwardRef<unknown, VirtuosoTestProps>((props, ref) => {
		mocks.virtuosoProps = props
		ReactModule.useImperativeHandle(ref, () => ({
			scrollToIndex: mocks.scrollToIndex,
		}))
		return ReactModule.createElement("div", {
			"data-testid": "virtuoso",
			"data-virtuoso-scroller": "true",
		})
	})

	return { Virtuoso }
})

vi.mock("@/components/chat/task-header/StickyUserMessage", () => ({
	StickyUserMessage: () => null,
}))

vi.mock("../messages/MessageRenderer", () => ({
	createMessageRenderer: () => () => null,
}))

function createMessages(startIndex: number, count: number): ClineMessage[] {
	return Array.from({ length: count }, (_, offset) => {
		const absoluteIndex = startIndex + offset
		return {
			ts: absoluteIndex + 1,
			type: "say",
			say: "text",
			text: `message-${absoluteIndex}`,
		} as ClineMessage
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

function renderMessagesArea(scrollBehavior = createScrollBehavior()) {
	const messages = mocks.initialMessages
	const task = messages[0] ?? createMessages(0, 1)[0]

	render(
		<MessagesArea
			chatState={
				{
					expandedRows: {},
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
		/>,
	)

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
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
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
			} as ClineMessage,
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
		mocks.fetchMessage.mockResolvedValue({ messages: [], startIndex: 0 })
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
			.mockResolvedValueOnce({ messages: createMessages(250, 50), startIndex: 250 })
			.mockResolvedValueOnce({ messages: [], startIndex: 50 })
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
})
