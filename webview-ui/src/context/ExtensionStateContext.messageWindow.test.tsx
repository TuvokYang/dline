import type { ExtensionState } from "@shared/ExtensionMessage"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const subscriptions = vi.hoisted(() => ({
	state: undefined as undefined | { onResponse: (response: { stateJson?: string }) => void },
	partial: undefined as undefined | { onResponse: (message: ReturnType<typeof convertClineMessageToProto>) => void },
}))

vi.mock("../services/grpc-client", () => {
	const unsubscribe = () => {}
	const stream = (_request: unknown, _handlers: unknown) => unsubscribe
	return {
		StateServiceClient: {
			subscribeToState: vi.fn((_request: unknown, handlers: typeof subscriptions.state) => {
				subscriptions.state = handlers
				return unsubscribe
			}),
			getAvailableTerminalProfiles: vi.fn(async () => ({ profiles: [] })),
		},
		TaskServiceClient: {
			fetchMessage: vi.fn(async () => ({ messages: [], startIndex: 0 })),
			dispatchInteraction: vi.fn(async () => ({ accepted: true, result: "accepted" })),
		},
		UiServiceClient: {
			subscribeToMcpButtonClicked: vi.fn(stream),
			subscribeToHistoryButtonClicked: vi.fn(stream),
			subscribeToChatButtonClicked: vi.fn(stream),
			subscribeToSettingsButtonClicked: vi.fn(stream),
			subscribeToWorktreesButtonClicked: vi.fn(stream),
			subscribeToPartialMessage: vi.fn((_request: unknown, handlers: typeof subscriptions.partial) => {
				subscriptions.partial = handlers
				return unsubscribe
			}),
			subscribeToAccountButtonClicked: vi.fn(stream),
			subscribeToRelinquishControl: vi.fn(stream),
			initializeWebview: vi.fn(async () => undefined),
		},
		McpServiceClient: {
			subscribeToMcpServers: vi.fn(stream),
			subscribeToMcpMarketplaceCatalog: vi.fn(stream),
		},
		ModelsServiceClient: {
			subscribeToOpenRouterModels: vi.fn(stream),
			subscribeToLiteLlmModels: vi.fn(stream),
			refreshOpenRouterModelsRpc: vi.fn(async () => ({ models: {} })),
			refreshHicapModels: vi.fn(async () => ({ models: {} })),
			refreshLiteLlmModelsRpc: vi.fn(async () => ({ models: {} })),
			refreshBasetenModelsRpc: vi.fn(async () => ({ models: {} })),
			refreshVercelAiGatewayModelsRpc: vi.fn(async () => ({ models: {} })),
			refreshClineModelsRpc: vi.fn(async () => ({ models: {} })),
		},
	}
})

import { ChatRowContent } from "../components/chat/ChatRow"
import { useChatState } from "../components/chat/chat-view/hooks/useChatState"
import { TaskServiceClient } from "../services/grpc-client"
import { InteractionHost } from "../task-interaction/InteractionHost"
import { ExtensionStateContextProvider, useExtensionState } from "./ExtensionStateContext"

function CapabilitySetterProbe({
	observed,
}: {
	observed: Array<{
		global: ReturnType<typeof useExtensionState>["setGlobalClineRulesToggles"]
		task: ReturnType<typeof useExtensionState>["setTaskCapabilityToggles"]
	}>
}) {
	const { setGlobalClineRulesToggles, setTaskCapabilityToggles, stateRevision } = useExtensionState()
	observed.push({ global: setGlobalClineRulesToggles, task: setTaskCapabilityToggles })
	return <div data-testid="setter-state-revision">{stateRevision ?? 0}</div>
}

function MessageProbe() {
	const { clineMessages } = useExtensionState()
	return (
		<div>
			{clineMessages.map((message, index) => (
				<ChatRowContent
					isExpanded={false}
					isLast={index === clineMessages.length - 1}
					key={message.ts}
					message={message}
					onSetQuote={vi.fn()}
					onToggleExpand={vi.fn()}
				/>
			))}
		</div>
	)
}

type MessageWindowState = Pick<
	ReturnType<typeof useExtensionState>,
	"clineMessages" | "firstItemIndex" | "setClineMessages" | "setFirstItemIndex"
>
type MessagePage = Awaited<ReturnType<typeof TaskServiceClient.fetchMessage>>

function MessageWindowProbe({ observe }: { observe: (window: MessageWindowState) => void }) {
	observe(useExtensionState())
	return null
}

function messagePage(start: number, end: number, total = end, taskInstanceId = "open-1"): MessagePage {
	return {
		taskId: "task-1",
		taskInstanceId,
		messages: Array.from({ length: end - start }, (_, offset) =>
			convertClineMessageToProto({
				ts: start + offset + 1,
				type: "say",
				say: "text",
				text: `Message ${start + offset + 1}`,
			}),
		),
		startIndex: start,
		totalCount: total,
	}
}

function deferredMessagePage() {
	let resolve!: (page: MessagePage) => void
	let reject!: (error: Error) => void
	const promise = new Promise<MessagePage>((onResolve, onReject) => {
		resolve = onResolve
		reject = onReject
	})
	return { promise, resolve, reject }
}

async function publishMessageTotal(revision: number, total: number, taskInstanceId = "open-1") {
	const snapshot = stateSnapshot({ revision, total })
	await act(async () => {
		subscriptions.state?.onResponse({
			stateJson: JSON.stringify({ ...snapshot, taskViewState: { ...snapshot.taskViewState, taskInstanceId } }),
		})
	})
}

async function mountMessageWindow(total = 33) {
	let current!: MessageWindowState
	render(
		<ExtensionStateContextProvider>
			<MessageWindowProbe
				observe={(window) => {
					current = window
				}}
			/>
		</ExtensionStateContextProvider>,
	)
	await publishMessageTotal(1, total)
	return () => current
}

function InteractionProbe({
	observedTaskIds,
	showTimeline = true,
}: {
	observedTaskIds: Array<string | undefined>
	showTimeline?: boolean
}) {
	const { clineMessages, currentTaskItem, taskViewState } = useExtensionState()
	const chatState = useChatState(clineMessages, currentTaskItem?.id)

	useEffect(() => {
		observedTaskIds.push(currentTaskItem?.id)
	}, [currentTaskItem?.id, observedTaskIds])

	return (
		<>
			<label>
				Interaction draft
				<input onChange={(event) => chatState.setInputValue(event.target.value)} value={chatState.inputValue} />
			</label>
			<div data-testid="active-task-id">{currentTaskItem?.id ?? "none"}</div>
			{taskViewState ? (
				<InteractionHost
					dispatch={TaskServiceClient.dispatchInteraction}
					draft={{
						text: chatState.inputValue,
						images: chatState.selectedImages,
						files: chatState.selectedFiles,
					}}
					messages={clineMessages}
					showTimeline={showTimeline}
					view={taskViewState}
				/>
			) : null}
		</>
	)
}

function outOfSyncInteractionState(revision: number, total = 1): ExtensionState {
	return {
		...stateSnapshot({ revision, total }),
		taskViewState: {
			taskId: "task-1",
			taskInstanceId: "open-1",
			phase: "awaiting_approval",
			stateRevision: revision,
			activeInteraction: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				kind: "qna_response",
				status: "awaiting",
				stateRevision: revision,
				taskAsk: "qna_respond",
				presentationKind: "qna_response",
				askMessageTs: 100,
			},
			input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
			footer: { actions: [] },
		},
	} as ExtensionState
}

/**
 * Publish a newer extension state while keeping the interaction identity fixed.
 *
 * Stale states are dropped by revision, so a retry must carry a newer top-level
 * revision. The recovery fetch key is derived from the interaction identity, so
 * bumping that too would silently change the key and stop exercising the
 * hydrated/in-flight bookkeeping the test is about.
 */
function pinnedAnchorState(stateRevision: number, total = 1): ExtensionState {
	const base = outOfSyncInteractionState(stateRevision, total) as ExtensionState & {
		taskViewState: { activeInteraction: { stateRevision: number } }
	}
	return {
		...base,
		taskViewState: {
			...base.taskViewState,
			activeInteraction: { ...base.taskViewState.activeInteraction, stateRevision: 1 },
		},
	} as ExtensionState
}

function stateSnapshot(input: { revision: number; total: number }): ExtensionState {
	return {
		stateRevision: input.revision,
		version: "test",
		currentTaskItem: { id: "task-1", task: "Task", ts: 1 },
		taskTitleMessage: { ts: 1, type: "say", say: "task", text: "Task" },
		totalMessageCount: input.total,
		taskViewState: {
			taskId: "task-1",
			taskInstanceId: "open-1",
			phase: "idle",
			stateRevision: input.revision,
			input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
			footer: { actions: [] },
		},
		welcomeViewCompleted: true,
	} as ExtensionState
}

function resumeInteractionState(revision: number, total = 1): ExtensionState {
	return {
		...stateSnapshot({ revision, total }),
		taskViewState: {
			taskId: "task-1",
			taskInstanceId: "open-1",
			phase: "paused",
			stateRevision: revision,
			activeInteraction: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "resume-1",
				kind: "resume",
				status: "awaiting",
				stateRevision: revision,
				taskAsk: "resume_task",
				presentationKind: "resume",
				askMessageTs: 100,
			},
			input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "resume" },
			footer: {
				actions: [
					{
						type: "resume",
						label: "Resume",
						appearance: "primary",
						enabled: true,
						payloadPolicy: "draft",
						dispatchTarget: "interaction",
					},
				],
			},
		},
	} as ExtensionState
}

function completionInteractionState(revision: number): ExtensionState {
	return {
		...stateSnapshot({ revision, total: 1 }),
		taskViewState: {
			taskId: "task-1",
			taskInstanceId: "open-1",
			phase: "completed",
			stateRevision: revision,
			activeInteraction: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "completion-1",
				kind: "completion",
				status: "awaiting",
				stateRevision: revision,
				taskAsk: "completion_result",
				presentationKind: "completion",
				askMessageTs: 100,
			},
			input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
			footer: {
				actions: [
					{
						type: "start_new_task",
						label: "Start New Task",
						appearance: "primary",
						enabled: true,
						payloadPolicy: "draft",
						dispatchTarget: "interaction",
					},
				],
			},
		},
	} as ExtensionState
}

describe("ExtensionStateContext persisted message reconciliation", () => {
	beforeEach(() => {
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockReset()
			.mockResolvedValue({ taskId: "task-1", taskInstanceId: "open-1", messages: [], startIndex: 0 })
		vi.mocked(TaskServiceClient.dispatchInteraction).mockReset().mockResolvedValue({ accepted: true, result: "accepted" })
		subscriptions.state = undefined
		subscriptions.partial = undefined
	})

	it.each([38, 45])("catches up a live tail when total grows during a bounded fetch reporting %i", async (responseTotal) => {
		const bounded = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockReturnValueOnce(bounded.promise)
			.mockResolvedValueOnce(messagePage(38, 45))
		const current = await mountMessageWindow()
		expect(current().clineMessages).toHaveLength(33)

		await publishMessageTotal(2, 38)
		expect(TaskServiceClient.fetchMessage).toHaveBeenLastCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 33,
			count: 5,
		})
		await publishMessageTotal(3, 45)
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
		await act(async () => {
			bounded.resolve(messagePage(33, 38, responseTotal))
		})

		expect(TaskServiceClient.fetchMessage).toHaveBeenNthCalledWith(3, {
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 38,
			count: 7,
		})
		expect(current().firstItemIndex).toBe(0)
		expect(current().clineMessages.map((message) => message.ts)).toEqual(Array.from({ length: 45 }, (_, index) => index + 1))
	})

	it.each(["rejected", "empty"])("retries a %s live-tail response on the next state update", async (outcome) => {
		const pending = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(messagePage(33, 45))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 38)
		await act(async () => {
			if (outcome === "rejected") pending.reject(new Error("temporary RPC failure"))
			else pending.resolve(messagePage(33, 33, 38))
		})
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
		await publishMessageTotal(3, 45)
		expect(current().clineMessages).toHaveLength(45)
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(3)
	})

	it("drains more than one bounded page without skipping or duplicating messages", async () => {
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockResolvedValueOnce(messagePage(33, 233, 440))
			.mockResolvedValueOnce(messagePage(233, 433, 440))
			.mockResolvedValueOnce(messagePage(433, 440))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 440)
		expect(current().clineMessages.map((message) => message.ts)).toEqual(Array.from({ length: 440 }, (_, index) => index + 1))
		expect(TaskServiceClient.fetchMessage).toHaveBeenNthCalledWith(3, {
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 233,
			count: 200,
		})
		expect(TaskServiceClient.fetchMessage).toHaveBeenNthCalledWith(4, {
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 433,
			count: 7,
		})
	})

	it("does not skip persisted rows when realtime messages arrive during a bounded fetch", async () => {
		const pending = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(messagePage(34, 36))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 34)
		act(() => {
			subscriptions.partial?.onResponse({ ...messagePage(35, 36).messages[0], taskId: "task-1", taskInstanceId: "open-1" })
		})
		await publishMessageTotal(3, 36)
		await act(async () => {
			pending.resolve(messagePage(33, 34, 36))
		})
		expect(TaskServiceClient.fetchMessage).toHaveBeenLastCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 34,
			count: 2,
		})
		expect(current().clineMessages.map((message) => message.ts)).toEqual(Array.from({ length: 36 }, (_, index) => index + 1))
	})

	it("retains the durable cursor after a failed page with optimistic realtime rows", async () => {
		const pending = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockReturnValueOnce(pending.promise)
			.mockRejectedValueOnce(new Error("temporary RPC failure"))
			.mockResolvedValueOnce(messagePage(34, 36))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 34)
		act(() => {
			subscriptions.partial?.onResponse({ ...messagePage(35, 36).messages[0], taskId: "task-1", taskInstanceId: "open-1" })
		})
		await publishMessageTotal(3, 36)
		await act(async () => {
			pending.resolve(messagePage(33, 34, 36))
		})
		await publishMessageTotal(4, 36)
		expect(TaskServiceClient.fetchMessage).toHaveBeenLastCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 34,
			count: 2,
		})
		expect(current().clineMessages.map((message) => message.ts)).toEqual(Array.from({ length: 36 }, (_, index) => index + 1))
	})

	it("retains the durable cursor when realtime rows arrive after a failed fetch", async () => {
		const retry = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockRejectedValueOnce(new Error("temporary RPC failure"))
			.mockReturnValueOnce(retry.promise)
			.mockResolvedValueOnce(messagePage(34, 35))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 34)
		act(() => {
			subscriptions.partial?.onResponse({ ...messagePage(34, 35).messages[0], taskId: "task-1", taskInstanceId: "open-1" })
		})
		expect(TaskServiceClient.fetchMessage).toHaveBeenLastCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 33,
			count: 1,
		})
		await publishMessageTotal(3, 35)
		await act(async () => {
			retry.resolve(messagePage(33, 34, 35))
		})
		expect(TaskServiceClient.fetchMessage).toHaveBeenLastCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 34,
			count: 1,
		})
		expect(current().clineMessages.map((message) => message.ts)).toEqual(Array.from({ length: 35 }, (_, index) => index + 1))
	})

	it("keeps the serialized live-tail control contiguous without duplicate requests", async () => {
		const bounded = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockReturnValueOnce(bounded.promise)
			.mockResolvedValueOnce(messagePage(38, 45))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 38)
		await act(async () => {
			bounded.resolve(messagePage(33, 38))
		})
		expect(current().clineMessages).toHaveLength(38)
		await publishMessageTotal(3, 45)
		expect(current().clineMessages).toHaveLength(45)
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(3)
	})

	it("preserves a deliberate historical window while totals grow and a tail request settles", async () => {
		const bounded = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage).mockResolvedValueOnce(messagePage(0, 33)).mockReturnValueOnce(bounded.promise)
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 38)
		act(() => {
			current().setClineMessages(current().clineMessages.slice(0, 10))
			current().setFirstItemIndex(0)
		})
		await publishMessageTotal(3, 45)
		await act(async () => {
			bounded.resolve(messagePage(0, 38, 45))
		})
		await publishMessageTotal(4, 46)
		act(() => {
			subscriptions.partial?.onResponse({
				...messagePage(45, 46).messages[0],
				taskId: "task-1",
				taskInstanceId: "open-1",
			})
		})
		expect(current().firstItemIndex).toBe(0)
		expect(current().clineMessages).toHaveLength(10)
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
	})

	it("invalidates an in-flight tail on truncate without letting its finalizer release the replacement lock", async () => {
		const bounded = deferredMessagePage()
		const replacement = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockReturnValueOnce(bounded.promise)
			.mockReturnValueOnce(replacement.promise)
			.mockResolvedValueOnce(messagePage(20, 22))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 38)
		vi.useFakeTimers()
		try {
			await publishMessageTotal(3, 20)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200)
			})
			expect(TaskServiceClient.fetchMessage).toHaveBeenNthCalledWith(3, {
				taskId: "task-1",
				taskInstanceId: "open-1",
				referenceIndex: -1,
				count: 200,
			})
			await act(async () => {
				bounded.resolve(messagePage(33, 38))
			})
			expect(current().clineMessages).toHaveLength(33)
			await publishMessageTotal(4, 22)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200)
			})
			expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(3)
			await act(async () => {
				replacement.resolve(messagePage(0, 20))
			})
			expect(current().clineMessages).toHaveLength(22)
			expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(4)
		} finally {
			vi.useRealTimers()
		}
	})

	it("replaces a pending bootstrap when its task is truncated to a positive total", async () => {
		const bootstrap = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage).mockReturnValueOnce(bootstrap.promise).mockResolvedValueOnce(messagePage(0, 20))
		const current = await mountMessageWindow()
		vi.useFakeTimers()
		try {
			await publishMessageTotal(2, 20)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200)
			})
			expect(current().clineMessages).toHaveLength(20)
			await act(async () => {
				bootstrap.resolve(messagePage(0, 33))
			})
			expect(current().clineMessages).toHaveLength(20)
			expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not repopulate a cleared task from an in-flight tail", async () => {
		const bounded = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage).mockResolvedValueOnce(messagePage(0, 33)).mockReturnValueOnce(bounded.promise)
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 38)
		await publishMessageTotal(3, 0)
		await act(async () => {
			bounded.resolve(messagePage(33, 38))
		})
		expect(current().clineMessages).toHaveLength(0)
		expect(current().firstItemIndex).toBe(0)
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
	})

	it("ignores an old task tail while the reopened task catches up its own bootstrap", async () => {
		const bounded = deferredMessagePage()
		const reopened = deferredMessagePage()
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce(messagePage(0, 33))
			.mockReturnValueOnce(bounded.promise)
			.mockReturnValueOnce(reopened.promise)
			.mockResolvedValueOnce(messagePage(10, 12, 12, "open-2"))
		const current = await mountMessageWindow()
		await publishMessageTotal(2, 38)
		await publishMessageTotal(3, 10, "open-2")
		await act(async () => {
			bounded.resolve(messagePage(33, 38))
		})
		expect(current().clineMessages).toHaveLength(0)
		await publishMessageTotal(4, 12, "open-2")
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(3)
		await act(async () => {
			reopened.resolve(messagePage(0, 10, 10, "open-2"))
		})
		expect(current().clineMessages).toHaveLength(12)
		expect(TaskServiceClient.fetchMessage).toHaveBeenLastCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-2",
			referenceIndex: 10,
			count: 2,
		})
	})

	it("keeps capability setter identities stable across extension state revisions", async () => {
		const observed: Array<{
			global: ReturnType<typeof useExtensionState>["setGlobalClineRulesToggles"]
			task: ReturnType<typeof useExtensionState>["setTaskCapabilityToggles"]
		}> = []
		render(
			<ExtensionStateContextProvider>
				<CapabilitySetterProbe observed={observed} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		const initialGlobal = observed.at(-1)?.global
		const initialTask = observed.at(-1)?.task

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 0 })) })
		})
		await waitFor(() => expect(screen.getByTestId("setter-state-revision")).toHaveTextContent("1"))
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 2, total: 0 })) })
		})
		await waitFor(() => expect(screen.getByTestId("setter-state-revision")).toHaveTextContent("2"))

		expect(initialGlobal).toBeDefined()
		expect(initialTask).toBeDefined()
		expect(observed.every((entry) => entry.global === initialGlobal && entry.task === initialTask)).toBe(true)
	})

	it("applies a verified TaskView patch without waiting for the persisted message window", async () => {
		vi.mocked(TaskServiceClient.fetchMessage).mockReturnValue(new Promise(() => {}))
		const preparingState = {
			...stateSnapshot({ revision: 1, total: 1 }),
			taskViewState: {
				taskId: "task-1",
				taskInstanceId: "open-1",
				phase: "paused",
				stateRevision: 1,
				input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
				footer: {
					actions: [
						{
							type: "resume",
							label: "Resume",
							appearance: "primary",
							enabled: false,
							payloadPolicy: "draft",
							dispatchTarget: "interaction",
						},
					],
				},
			},
		} as ExtensionState
		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={[]} showTimeline={false} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(preparingState) })
		})
		await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "true"))

		const completed = completionInteractionState(2)
		if (!completed.taskViewState?.activeInteraction) throw new Error("Expected active completion interaction")
		completed.taskViewState.activeInteraction.anchorVerified = true
		act(() => {
			subscriptions.state?.onResponse({
				stateJson: JSON.stringify({
					__dlineStatePatch: true,
					stateRevision: 2,
					taskViewState: completed.taskViewState,
				}),
			})
		})

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Start New Task" })).toHaveAttribute("aria-disabled", "false"),
		)
		expect(screen.getByTestId("active-task-id")).toHaveTextContent("task-1")
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledOnce()
	})

	it("dispatches anchored Resume without clearing the active task identity or draft", async () => {
		const resumeAsk = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "resume_task",
			text: "Resume task",
			interactionId: "resume-1",
		})
		vi.mocked(TaskServiceClient.fetchMessage).mockResolvedValue({
			taskId: "task-1",
			taskInstanceId: "open-1",
			messages: [resumeAsk],
			startIndex: 0,
		})
		const observedTaskIds: Array<string | undefined> = []
		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={observedTaskIds} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(resumeInteractionState(1)) })
		})
		await waitFor(() => expect(screen.getByTestId("active-task-id")).toHaveTextContent("task-1"))
		await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeVisible())
		fireEvent.change(screen.getByLabelText("Interaction draft"), { target: { value: "continue carefully" } })
		observedTaskIds.length = 0

		fireEvent.click(screen.getByRole("button", { name: "Resume" }))
		await waitFor(() => expect(TaskServiceClient.dispatchInteraction).toHaveBeenCalledOnce())
		await waitFor(() => expect(screen.getByTestId("active-task-id")).toHaveTextContent("task-1"))

		expect(TaskServiceClient.dispatchInteraction).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "resume-1",
				actionId: "resume",
				stateRevision: 1,
				draft: { text: "continue carefully", images: [], files: [] },
			}),
		)
		expect(screen.getByLabelText("Interaction draft")).toHaveValue("continue carefully")
		expect(observedTaskIds).not.toContain(undefined)
	})

	it("retries an ordinary history window when the first response is empty despite a positive total", async () => {
		const persisted = convertClineMessageToProto({ ts: 20, type: "say", say: "text", text: "persisted history" })
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [], startIndex: 0, totalCount: 2 })
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-1",
				messages: [persisted],
				startIndex: 1,
				totalCount: 2,
			})
		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 2 })) })
		})

		await waitFor(() => expect(screen.getByText("persisted history")).toBeVisible())
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
	})

	it("retries a Resume history window when consecutive responses are empty despite a positive total", async () => {
		const url = "http://127.0.0.1:1851/mock/web-fetch/page"
		const errorMessage = "E2E Web Fetch blocked by PreToolUse hook"
		const failedWebFetch = convertClineMessageToProto({
			ts: 90,
			type: "say",
			say: "tool",
			text: JSON.stringify({
				tool: "webFetch",
				path: url,
				content: `Web fetch failed: ${errorMessage}`,
				operationIsLocatedInWorkspace: false,
				webFetch: {
					schemaVersion: 1,
					status: "failed",
					url,
					prompt: "This fetch must be blocked before provider execution",
					error: errorMessage,
				},
			}),
		})
		const resumeAsk = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "resume_task",
			text: "",
			interactionId: "resume-1",
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [], startIndex: 0, totalCount: 2 })
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [], startIndex: 0, totalCount: 2 })
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-1",
				messages: [failedWebFetch, resumeAsk],
				startIndex: 0,
				totalCount: 2,
			})
		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(resumeInteractionState(1, 2)) })
		})

		await waitFor(() => expect(screen.getByTestId("web-fetch-card")).toBeVisible())
		expect(screen.getByTestId("web-fetch-card")).toHaveTextContent(url)
		expect(screen.getByTestId("web-fetch-card")).toHaveTextContent(errorMessage)
		expect(screen.queryByTestId("web-fetch-results")).not.toBeInTheDocument()
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(3)
	})

	it("retries an ordinary history window after the first fetch throws", async () => {
		const persisted = convertClineMessageToProto({ ts: 20, type: "say", say: "text", text: "recovered history" })
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockRejectedValueOnce(new Error("transient fetch failure"))
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-1",
				messages: [persisted],
				startIndex: 0,
				totalCount: 1,
			})
		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})

		await waitFor(() => expect(screen.getByText("recovered history")).toBeVisible())
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
	})

	it("automatically refetches a missing exact anchor without clearing the draft", async () => {
		const ask = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "qna_respond",
			text: "Question",
			interactionId: "interaction-1",
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [], startIndex: 0 })
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [ask], startIndex: 0 })
		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={[]} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(outOfSyncInteractionState(1)) })
		})
		fireEvent.change(screen.getByLabelText("Interaction draft"), { target: { value: "keep unsent draft" } })

		await waitFor(() => expect(screen.getByText("Question")).toBeVisible())
		expect(screen.getByLabelText("Interaction draft")).toHaveValue("keep unsent draft")
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: -1,
			count: 200,
		})
	})

	it("walks backward through persisted windows until it finds an older interaction anchor", async () => {
		const tail = Array.from({ length: 200 }, (_, index) =>
			convertClineMessageToProto({
				ts: 200 + index,
				type: "say",
				say: "text",
				text: index === 199 ? "Latest message" : `Tail message ${index + 1}`,
			}),
		)
		const ask = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "qna_respond",
			text: "Older question",
			interactionId: "interaction-1",
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: tail, startIndex: 1, totalCount: 201 })
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-1",
				messages: [ask],
				startIndex: 0,
				totalCount: 201,
			})
		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={[]} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(outOfSyncInteractionState(1, 201)) })
		})

		await waitFor(() => expect(screen.getByText("Older question")).toBeVisible())
		expect(TaskServiceClient.fetchMessage).toHaveBeenNthCalledWith(1, {
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: -1,
			count: 200,
		})
		expect(TaskServiceClient.fetchMessage).toHaveBeenNthCalledWith(2, {
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 0,
			count: 200,
		})
	})

	it("does not let a stale completion say downgrade a realtime completion ask anchor", async () => {
		const staleSay = convertClineMessageToProto({
			ts: 100,
			type: "say",
			say: "completion_result",
			text: "Completed",
		})
		const completionAsk = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "completion_result",
			text: "Completed",
			interactionId: "completion-1",
		})
		let resolveStaleFetch:
			| ((value: { taskId: string; taskInstanceId: string; messages: [typeof staleSay]; startIndex: number }) => void)
			| undefined
		const staleFetch = new Promise<{
			taskId: string
			taskInstanceId: string
			messages: [typeof staleSay]
			startIndex: number
		}>((resolve) => {
			resolveStaleFetch = resolve
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockReturnValueOnce(staleFetch)
			.mockResolvedValue({ taskId: "task-1", taskInstanceId: "open-1", messages: [staleSay], startIndex: 0 })

		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={[]} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(completionInteractionState(1)) })
		})
		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledOnce())

		act(() => {
			subscriptions.partial?.onResponse({ ...completionAsk, taskId: "task-1", taskInstanceId: "open-1" })
		})
		await waitFor(() => expect(screen.getByRole("button", { name: "Start New Task" })).toBeVisible())

		await act(async () => {
			resolveStaleFetch?.({ taskId: "task-1", taskInstanceId: "open-1", messages: [staleSay], startIndex: 0 })
			await staleFetch
		})

		// The stale response carries a say at the anchor timestamp, but the local
		// realtime ask wins reconciliation, so the committed window still holds
		// the anchor. Judging success there means no redundant walk-back is
		// issued; this assertion previously counted that spurious second fetch.
		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(1))
		expect(screen.getByRole("button", { name: "Start New Task" })).toBeVisible()
	})

	it("renders partial user_feedback through ChatRow when the realtime event arrives normally", async () => {
		const feedback = convertClineMessageToProto({
			ts: 20,
			type: "say",
			say: "user_feedback",
			text: "streaming feedback",
			partial: true,
		})
		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})
		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledOnce())

		act(() => {
			subscriptions.partial?.onResponse({ ...feedback, taskId: "task-1", taskInstanceId: "open-1" })
		})

		await waitFor(() => expect(screen.getByText("streaming feedback")).toBeVisible())
		expect(screen.getAllByText("streaming feedback")).toHaveLength(1)
	})

	it("updates a finalized command row when its execution mode changes through the realtime stream", async () => {
		const foregroundCommand = convertClineMessageToProto({
			ts: 20,
			type: "say",
			say: "command",
			text: 'node -e "setTimeout(() => {}, 12000)"',
			partial: false,
			commandStatus: "running",
			commandExecutionMode: "foreground",
		})
		const backgroundCommand = convertClineMessageToProto({
			ts: 20,
			type: "say",
			say: "command",
			text: 'node -e "setTimeout(() => {}, 12000)"',
			partial: false,
			commandStatus: "running",
			commandExecutionMode: "background",
		})
		vi.mocked(TaskServiceClient.fetchMessage).mockResolvedValueOnce({
			taskId: "task-1",
			taskInstanceId: "open-1",
			messages: [foregroundCommand],
			startIndex: 0,
			totalCount: 1,
		})

		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})
		await waitFor(() => expect(screen.getByTestId("command-execution-mode")).toHaveTextContent("Foreground"))

		act(() => {
			subscriptions.partial?.onResponse({
				...backgroundCommand,
				taskId: "task-1",
				taskInstanceId: "open-1",
			})
		})

		await waitFor(() => expect(screen.getByTestId("command-execution-mode")).toHaveTextContent("Background"))
	})

	it("fetches the missing tail when persisted user_feedback increases the total but its stream event is lost", async () => {
		const initial = convertClineMessageToProto({ ts: 10, type: "say", say: "text", text: "assistant" })
		const feedback = convertClineMessageToProto({ ts: 20, type: "say", say: "user_feedback", text: "visible feedback" })
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [initial], startIndex: 0 })
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [initial, feedback], startIndex: 0 })

		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})
		await waitFor(() => expect(screen.getByText("assistant")).toBeVisible())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 2, total: 2 })) })
		})

		await waitFor(() => expect(screen.getByText("visible feedback")).toBeVisible())
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
		expect(screen.getAllByText("visible feedback")).toHaveLength(1)
		expect(subscriptions.partial).toBeDefined()
	})

	it("recovers a missed message even when a later realtime message is already present", async () => {
		const initial = convertClineMessageToProto({ ts: 10, type: "say", say: "text", text: "assistant" })
		const feedback = convertClineMessageToProto({ ts: 20, type: "say", say: "user_feedback", text: "missed feedback" })
		const later = convertClineMessageToProto({ ts: 30, type: "say", say: "text", text: "later response" })
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [initial], startIndex: 0 })
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-1",
				messages: [feedback, later],
				startIndex: 1,
				totalCount: 3,
			})

		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})
		await waitFor(() => expect(screen.getByText("assistant")).toBeVisible())

		act(() => {
			subscriptions.partial?.onResponse({ ...later, taskId: "task-1", taskInstanceId: "open-1" })
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 2, total: 3 })) })
		})

		await waitFor(() => expect(screen.getByText("missed feedback")).toBeVisible())
		expect(screen.getAllByText("later response")).toHaveLength(1)
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
		expect(TaskServiceClient.fetchMessage).toHaveBeenLastCalledWith({
			taskId: "task-1",
			taskInstanceId: "open-1",
			referenceIndex: 1,
			count: 2,
		})
		expect(
			screen.getByText("missed feedback").compareDocumentPosition(screen.getByText("later response")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
	})

	it("replaces a stale realtime partial when durable state publishes a different tail at the same total", async () => {
		const initial = convertClineMessageToProto({ ts: 10, type: "say", say: "text", text: "assistant" })
		const stalePartial = convertClineMessageToProto({
			ts: 20,
			type: "say",
			say: "text",
			text: "stale partial",
			partial: true,
		})
		const durableReplacement = convertClineMessageToProto({
			ts: 30,
			type: "say",
			say: "text",
			text: "durable replacement",
			partial: false,
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [initial], startIndex: 0 })
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-1",
				messages: [initial, durableReplacement],
				startIndex: 0,
			})

		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})
		await waitFor(() => expect(screen.getByText("assistant")).toBeVisible())

		act(() => {
			subscriptions.partial?.onResponse({ ...stalePartial, taskId: "task-1", taskInstanceId: "open-1" })
		})
		await waitFor(() => expect(screen.getByText("stale partial")).toBeVisible())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 2, total: 2 })) })
		})

		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2))
		await waitFor(() => expect(screen.getByText("durable replacement")).toBeVisible())
		expect(screen.queryByText("stale partial")).toBeNull()
	})

	it("deduplicates a delayed partial event after the persisted tail has already been recovered", async () => {
		const initial = convertClineMessageToProto({ ts: 10, type: "say", say: "text", text: "assistant" })
		const feedback = convertClineMessageToProto({ ts: 20, type: "say", say: "user_feedback", text: "visible feedback" })
		const stalePartial = convertClineMessageToProto({
			ts: 20,
			type: "say",
			say: "user_feedback",
			text: "stale fragment",
			partial: true,
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [initial], startIndex: 0 })
			.mockResolvedValueOnce({ taskId: "task-1", taskInstanceId: "open-1", messages: [initial, feedback], startIndex: 0 })

		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})
		await waitFor(() => expect(screen.getByText("assistant")).toBeVisible())
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 2, total: 2 })) })
		})
		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2))
		await waitFor(() => expect(screen.getByText("visible feedback")).toBeVisible())

		act(() => {
			subscriptions.partial?.onResponse({ ...stalePartial, taskId: "task-1", taskInstanceId: "open-1" })
		})

		await waitFor(() => expect(screen.getAllByText("visible feedback")).toHaveLength(1))
		expect(screen.queryByText("stale fragment")).toBeNull()
	})

	it("does not treat an anchor-bearing but disjoint response as a hydrated anchor", async () => {
		// The local window is the tail; the anchor sits far behind it, so the
		// walk-back response is dropped by the continuous-window contract even
		// though it literally contains the anchor. Judging success on the raw
		// response would record the anchor as hydrated while it is still
		// unusable, permanently suppressing later recoveries.
		const tail = convertClineMessageToProto({ ts: 900, type: "say", say: "text", text: "tail message" })
		const ask = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "qna_respond",
			text: "Question",
			interactionId: "interaction-1",
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-1",
				messages: [tail],
				startIndex: 400,
				totalCount: 401,
			})
			.mockResolvedValue({ taskId: "task-1", taskInstanceId: "open-1", messages: [ask], startIndex: 0, totalCount: 401 })

		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={[]} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(pinnedAnchorState(1, 401)) })
		})

		// The tail arrives first, then recovery walks back and receives the
		// anchor in a window that cannot be joined to the local one.
		await waitFor(() =>
			expect(TaskServiceClient.fetchMessage).toHaveBeenNthCalledWith(2, {
				taskId: "task-1",
				taskInstanceId: "open-1",
				referenceIndex: 200,
				count: 200,
			}),
		)

		// Judging success on the raw response would stop here, because that
		// response does contain the anchor. Recovery must instead keep trying,
		// since the committed window still cannot resolve the anchor.
		await waitFor(() => expect(TaskServiceClient.fetchMessage.mock.calls.length).toBeGreaterThan(2))
		expect(screen.queryByText("Question")).toBeNull()
		expect(screen.queryByRole("alert")).toBeNull()
	})

	it("retries a failed anchor recovery instead of suppressing it permanently", async () => {
		const ask = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "qna_respond",
			text: "Question",
			interactionId: "interaction-1",
		})
		// A failed attempt must not be recorded as a hydrated anchor, otherwise
		// the footer stays disabled for the rest of the task.
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockRejectedValueOnce(new Error("transient anchor fetch failure"))
			.mockResolvedValue({ taskId: "task-1", taskInstanceId: "open-1", messages: [ask], startIndex: 0, totalCount: 1 })

		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={[]} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(pinnedAnchorState(1)) })
		})
		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(1))
		expect(screen.queryByText("Question")).toBeNull()

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(pinnedAnchorState(2)) })
		})

		await waitFor(() => expect(screen.getByText("Question")).toBeVisible())
	})

	it.each([
		"resolve",
		"reject",
	] as const)("isolates a same-ID reopen without history metadata from a late page %s and old partial", async (settlement) => {
		const oldMessage = convertClineMessageToProto({ ts: 10, type: "say", say: "text", text: "Old opening body" })
		const currentMessage = convertClineMessageToProto({ ts: 11, type: "say", say: "text", text: "Current opening body" })
		type Page = Awaited<ReturnType<typeof TaskServiceClient.fetchMessage>>
		let resolveOld!: (page: Page) => void
		let rejectOld!: (error: Error) => void
		const oldPage = new Promise<Page>((resolve, reject) => {
			resolveOld = resolve
			rejectOld = reject
		})
		vi.mocked(TaskServiceClient.fetchMessage)
			.mockReturnValueOnce(oldPage)
			.mockResolvedValueOnce({
				taskId: "task-1",
				taskInstanceId: "open-2",
				messages: [currentMessage],
				startIndex: 0,
				totalCount: 1,
			})
		render(
			<ExtensionStateContextProvider>
				<MessageProbe />
			</ExtensionStateContextProvider>,
		)
		await act(async () => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(stateSnapshot({ revision: 1, total: 1 })) })
		})
		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(1))
		const reopened = stateSnapshot({ revision: 2, total: 1 })
		await act(async () => {
			subscriptions.state?.onResponse({
				stateJson: JSON.stringify({
					...reopened,
					currentTaskItem: undefined,
					taskViewState: { ...reopened.taskViewState, taskInstanceId: "open-2" },
				}),
			})
		})
		await waitFor(() => expect(screen.getByText("Current opening body")).toBeVisible())
		await act(async () => {
			if (settlement === "resolve")
				resolveOld({
					taskId: "task-1",
					taskInstanceId: "open-1",
					messages: [oldMessage],
					startIndex: 0,
					totalCount: 1,
				})
			else rejectOld(new Error("late page failure"))
			subscriptions.partial?.onResponse({ ...oldMessage, taskId: "task-1", taskInstanceId: "open-1" })
		})
		expect(screen.getByText("Current opening body")).toBeVisible()
		expect(screen.queryByText("Old opening body")).toBeNull()
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(2)
	})

	it("does not start a second recovery for an anchor whose fetch is still running", async () => {
		const ask = convertClineMessageToProto({
			ts: 100,
			type: "ask",
			ask: "qna_respond",
			text: "Question",
			interactionId: "interaction-1",
		})
		type PendingPage = {
			taskId: string
			taskInstanceId: string
			messages: [typeof ask]
			startIndex: number
			totalCount: number
		}
		let resolvePending: ((value: PendingPage) => void) | undefined
		const pending = new Promise<PendingPage>((resolve) => {
			resolvePending = resolve
		})
		vi.mocked(TaskServiceClient.fetchMessage).mockReturnValueOnce(pending as never)

		render(
			<ExtensionStateContextProvider>
				<InteractionProbe observedTaskIds={[]} />
			</ExtensionStateContextProvider>,
		)
		await waitFor(() => expect(subscriptions.state).toBeDefined())

		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(pinnedAnchorState(1)) })
		})
		await waitFor(() => expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(1))

		// Re-publishing the same interaction identity must not fan out a
		// duplicate request while the first one is still in flight.
		act(() => {
			subscriptions.state?.onResponse({ stateJson: JSON.stringify(pinnedAnchorState(2)) })
		})
		expect(TaskServiceClient.fetchMessage).toHaveBeenCalledTimes(1)

		await act(async () => {
			resolvePending?.({ taskId: "task-1", taskInstanceId: "open-1", messages: [ask], startIndex: 0, totalCount: 1 })
			await pending
		})

		await waitFor(() => expect(screen.getByText("Question")).toBeVisible())
	})
})
