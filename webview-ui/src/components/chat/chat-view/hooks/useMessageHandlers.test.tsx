import type { UiMessage } from "@shared/ExtensionMessage"
import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SemanticComposerEngine } from "../../input/semantic-composer/engine"
import { stateFromText } from "../../input/semantic-composer/model"
import type { ChatState, NewTaskComposition } from "../types/chatTypes"

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

const CATALOG = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS } as unknown as InputSemanticCatalog

/** The frozen draft one send composes a new task from. */
function compose(text: string): NewTaskComposition {
    return { segments: stateFromText(text).segments, catalog: CATALOG }
}

function createChatState(): ChatState {
    const engine = new SemanticComposerEngine()
    return {
        composer: {
            engine,
            state: engine.getState(),
            draftId: "00000000-0000-4000-8000-000000000001",
            documentId: "00000000-0000-4000-8000-000000000002",
            flatText: "你好",
            sendRefusal: undefined,
            reportSendRefusal: vi.fn(),
            load: vi.fn(),
            clear: vi.fn(),
            retire: vi.fn(),
            setText: vi.fn(),
        },
        inputValue: "你好",
        setInputValue: vi.fn(),
        activeQuote: null,
        setActiveQuote: vi.fn(),
        isTextAreaFocused: true,
        setIsTextAreaFocused: vi.fn(),
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
        composerRef: { current: null },
        lastMessage: undefined,
        secondLastMessage: undefined,
        handleFocusChange: vi.fn(),
        clearExpandedRows: vi.fn(),
        resetState: vi.fn(),
        restoreDraft: vi.fn(),
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

        const composition = compose("你好")
        await expect(result.current.handleSendMessage(composition)).rejects.toThrow("task creation failed")

        // The draft is retired optimistically and the frozen segments come back whole.
        expect(chatState.composer.retire).toHaveBeenCalledOnce()
        expect(chatState.composer.load).toHaveBeenCalledWith(composition.segments)
    })

    it("starts a Welcome task while messages from the closed task are still being cleared", async () => {
        const chatState = createChatState()
        mocks.newTask.mockResolvedValueOnce(undefined)
        const { result } = renderHook(() => useMessageHandlers([TASK_MESSAGE], chatState, undefined, undefined))

        await result.current.handleSendMessage(compose("next task"))

        expect(mocks.newTask).toHaveBeenCalledOnce()
        expect(chatState.composer.retire).toHaveBeenCalledOnce()
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
            submission = result.current.handleSendMessage(compose("你好"))
        })
        rerender({ messages: [TASK_MESSAGE], taskId: "task-1" })
        rejectNewTask(new Error("late RPC failure"))

        await expect(submission).rejects.toThrow("late RPC failure")
        expect(chatState.composer.retire).toHaveBeenCalledOnce()
        expect(chatState.composer.load).not.toHaveBeenCalled()
    })

    it("lets the backend snapshot workspace capability defaults for a Welcome task", async () => {
        const chatState = createChatState()
        mocks.newTask.mockResolvedValueOnce(undefined)
        const { result } = renderHook(() => useMessageHandlers([], chatState, undefined, undefined))

        await result.current.handleSendMessage(compose("new task"))

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
