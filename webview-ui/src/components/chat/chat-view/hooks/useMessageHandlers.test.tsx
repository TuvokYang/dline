import type { UiMessage } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ChatState } from "../types/chatTypes"

const mocks = vi.hoisted(() => ({
	newTask: vi.fn(),
	clearTask: vi.fn(async () => undefined),
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		newTask: mocks.newTask,
		clearTask: mocks.clearTask,
	},
}))

import { useMessageHandlers } from "./useMessageHandlers"

const TASK_MESSAGE: UiMessage = {
	ts: 1,
	type: "say",
	say: "task",
	text: "你好",
}

function createChatState(): ChatState {
	return {
		inputValue: "你好",
		setInputValue: vi.fn(),
		activeQuote: null,
		setActiveQuote: vi.fn(),
		isTextAreaFocused: true,
		setIsTextAreaFocused: vi.fn(),
		selectedImages: [],
		setSelectedImages: vi.fn(),
		selectedFiles: [],
		setSelectedFiles: vi.fn(),
		sendingDisabled: false,
		setSendingDisabled: vi.fn(),
		enableButtons: true,
		setEnableButtons: vi.fn(),
		primaryButtonText: undefined,
		setPrimaryButtonText: vi.fn(),
		secondaryButtonText: undefined,
		setSecondaryButtonText: vi.fn(),
		expandedRows: {},
		setExpandedRows: vi.fn(),
		textAreaRef: { current: null },
		lastMessage: undefined,
		secondLastMessage: undefined,
		handleFocusChange: vi.fn(),
		clearExpandedRows: vi.fn(),
		resetState: vi.fn(),
	}
}

describe("useMessageHandlers new task submission", () => {
	beforeEach(() => {
		mocks.newTask.mockReset()
		mocks.clearTask.mockClear()
	})

	it("restores the Welcome draft when task creation fails before a task appears", async () => {
		const chatState = createChatState()
		mocks.newTask.mockRejectedValueOnce(new Error("task creation failed"))
		const { result } = renderHook(() => useMessageHandlers([], chatState))

		await expect(result.current.handleSendMessage("你好", [], [])).rejects.toThrow("task creation failed")

		expect(chatState.setInputValue).toHaveBeenNthCalledWith(1, "")
		expect(chatState.setInputValue).toHaveBeenNthCalledWith(2, "你好")
	})

	it("starts a Welcome task while messages from the closed task are still being cleared", async () => {
		const chatState = createChatState()
		mocks.newTask.mockResolvedValueOnce(undefined)
		const { result } = renderHook(() => useMessageHandlers([TASK_MESSAGE], chatState, undefined, undefined))

		await result.current.handleSendMessage("next task", [], [])

		expect(mocks.newTask).toHaveBeenCalledOnce()
		expect(chatState.setInputValue).toHaveBeenCalledWith("")
	})

	it("does not restore the Welcome draft after the new task message appears", async () => {
		let rejectNewTask!: (error: Error) => void
		mocks.newTask.mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				rejectNewTask = reject
			}),
		)
		const chatState = createChatState()
		const { result, rerender } = renderHook(
			({ messages, taskId }: { messages: UiMessage[]; taskId?: string }) =>
				useMessageHandlers(messages, chatState, undefined, taskId),
			{ initialProps: { messages: [], taskId: undefined } },
		)

		let submission!: Promise<void>
		act(() => {
			submission = result.current.handleSendMessage("你好", [], [])
		})
		rerender({ messages: [TASK_MESSAGE], taskId: "task-1" })
		rejectNewTask(new Error("late RPC failure"))

		await expect(submission).rejects.toThrow("late RPC failure")
		expect(chatState.setInputValue).toHaveBeenCalledWith("")
		expect(chatState.setInputValue).not.toHaveBeenCalledWith("你好")
	})

	it("lets the backend snapshot workspace capability defaults for a Welcome task", async () => {
		const chatState = createChatState()
		mocks.newTask.mockResolvedValueOnce(undefined)
		const { result } = renderHook(() => useMessageHandlers([], chatState, undefined, undefined))

		await result.current.handleSendMessage("new task", [], [])

		const request = mocks.newTask.mock.calls[0][0]
		expect(request.taskSettings).toBeUndefined()
	})

	it("clears the active task without copying task capability state", async () => {
		const chatState = createChatState()
		const { result } = renderHook(() => useMessageHandlers([], chatState, undefined, "task-1"))

		await result.current.startNewTask()

		expect(mocks.clearTask).toHaveBeenCalledOnce()
	})
})
