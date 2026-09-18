import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineErrorRetryMessages } from "@shared/combineErrorRetryMessages"
import { combineHookSequences } from "@shared/combineHookSequences"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { taskPhaseStillDelivers } from "@shared/InputQueueDelivery"
import { BooleanRequest, StringRequest } from "@shared/proto/dline/common"
import type { ModelInfo } from "@shared/proto/dline/models"
import { AskResponseRequest, CompactTaskRequest } from "@shared/proto/dline/task"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useApiProfiles } from "@/components/settings/providers/useApiProfiles"
import { useProviderModels } from "@/components/settings/providers/useProviderModels"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useShowNavbar } from "@/context/PlatformContext"
import { FileServiceClient, TaskServiceClient, UiServiceClient } from "@/services/grpc-client"
import { createInteractionDispatchGate } from "@/task-interaction/dispatch-gate"
import { InteractionHost } from "@/task-interaction/InteractionHost"
import { isPresentationKind } from "@/task-interaction/renderer-registry"
import {
	type AcceptedInteractionSettlement,
	buildInteractionRequest,
	canApplyAcceptedInteractionSettlement,
	canRestoreRejectedInteractionDraft,
	captureInteractionDraft,
	createAcceptedInteractionSettlement,
	type InteractionDraft,
	isActiveInteractionSynchronized,
	type PendingSuccessorDraftTransfer,
} from "@/task-interaction/types"
import { Navbar } from "../menu/Navbar"
import { TaskActivityNavigationProvider } from "./activity/TaskActivityNavigationContext"
import { DEFAULT_TASK_ACTIVITY_FILTERS, type TaskActivityFilters, TaskActivityPanel } from "./activity/TaskActivityPanel"
import { TaskActivityTabs, type TaskContentTab } from "./activity/TaskActivityTabs"
import { useTaskActivities } from "./activity/useTaskActivities"
import AutoApproveBar from "./auto-approve-menu/AutoApproveBar"
// Import utilities and hooks from the new structure
import {
	CHAT_CONSTANTS,
	ChatLayout,
	convertHtmlToMarkdown,
	filterVisibleMessages,
	groupLowStakesTools,
	groupMessages,
	InputSection,
	MessagesArea,
	TaskSection,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
	WelcomeSection,
} from "./chat-view"
import { resolveActiveProfile, resolveTaskCurrency } from "./chat-view/utils/profileUtils"
import { useInputQueue } from "./input/useInputQueue"

interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
}

// Use constants from the imported module
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const QUICK_WINS_HISTORY_THRESHOLD = 3
const EMPTY_MODEL_INFO: ModelInfo = { id: "", capabilities: {}, pricing: {} }
const MANUAL_COMPACT_COMMAND = "/cmd:compact"

const ChatView = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	const showNavbar = useShowNavbar()
	const {
		version,
		clineMessages: messages,
		taskHistory,
		apiConfiguration,
		mode,
		userInfo,
		currentFocusChainChecklist,
		focusChainSettings,
		hooksEnabled,
		apiMetrics,
		lastApiReqTotalTokens: lastApiReqTotalTokensFromState,
		taskViewState,
		currentTaskItem,
		taskTitleMessage,
	} = useExtensionState()
	const [contentTab, setContentTab] = useState<TaskContentTab>("chat")
	const [focusedActivityId, setFocusedActivityId] = useState<string>()
	const [pendingSuccessorDraft, setPendingSuccessorDraft] = useState<PendingSuccessorDraftTransfer>()
	const [compactCommandPending, setCompactCommandPending] = useState(false)
	const compactCommandPendingRef = useRef(false)
	const dispatchInteraction = useMemo(
		() => createInteractionDispatchGate(TaskServiceClient.dispatchInteraction.bind(TaskServiceClient)),
		[],
	)
	const [forceTruncateTaskRpcPending, setForceTruncateTaskRpcPending] = useState(false)
	const forceTruncateTaskRpcPendingRef = useRef(false)
	const [activityFilters, setActivityFilters] = useState<TaskActivityFilters>(DEFAULT_TASK_ACTIVITY_FILTERS)
	const task = taskTitleMessage
	const taskId = task ? (taskViewState?.taskId ?? currentTaskItem?.id) : undefined
	const contextCompactionActive = taskViewState?.contextCompaction?.active === true
	const { activeCount } = useTaskActivities(taskId)
	useEffect(() => {
		setContentTab("chat")
		setFocusedActivityId(undefined)
		setActivityFilters(DEFAULT_TASK_ACTIVITY_FILTERS)
		compactCommandPendingRef.current = false
		setCompactCommandPending(false)
		forceTruncateTaskRpcPendingRef.current = false
		setForceTruncateTaskRpcPending(false)
	}, [taskId])
	const handleContentTabChange = useCallback((nextTab: TaskContentTab) => {
		setContentTab(nextTab)
		if (nextTab === "chat") setFocusedActivityId(undefined)
	}, [])
	const navigateToActivity = useCallback((activityId: string) => {
		setFocusedActivityId(activityId)
		setContentTab("activity")
	}, [])
	const handleActivityFiltersChange = useCallback((nextFilters: TaskActivityFilters) => {
		setActivityFilters(nextFilters)
		setFocusedActivityId(undefined)
	}, [])
	const isProdHostedApp = userInfo?.apiBaseUrl === "https://app.dline.bot"
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD)

	// task is no longer at index 0 — it's sent separately via taskMessage and displayed in fixed header
	const modifiedMessages = useMemo(() => {
		// task is separate (taskMessage) — no need to slice
		const withHooks = hooksEnabled ? combineHookSequences(messages) : messages
		return combineErrorRetryMessages(combineApiRequests(combineCommandSequences(withHooks)))
	}, [messages, hooksEnabled])
	const interactionSynchronized = taskViewState
		? isActiveInteractionSynchronized(modifiedMessages, taskViewState) &&
			(!taskViewState.activeInteraction || isPresentationKind(taskViewState.activeInteraction.presentationKind))
		: true
	// apiMetrics and lastApiReqTotalTokens are computed by the backend
	// and delivered via subscribeToState, independent of the message window.
	const lastApiReqTotalTokens = lastApiReqTotalTokensFromState

	// Use custom hooks for state management
	const chatState = useChatState(messages, taskId)
	// Retained input the user typed while the task was busy. The backend owns it;
	// this only projects it and forwards the user's changes.
	const inputQueue = useInputQueue(taskId)
	const {
		inputValue,
		setInputValue,
		activeQuote,
		setActiveQuote,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		restoreDraft,
		expandedRows,
		setExpandedRows,
		textAreaRef,
	} = chatState
	const draftRevisionRef = useRef(0)
	const previousDraftSourceRef = useRef({ inputValue, activeQuote, selectedImages, selectedFiles })
	const previousDraftSource = previousDraftSourceRef.current
	if (
		previousDraftSource.inputValue !== inputValue ||
		previousDraftSource.activeQuote !== activeQuote ||
		previousDraftSource.selectedImages !== selectedImages ||
		previousDraftSource.selectedFiles !== selectedFiles
	) {
		draftRevisionRef.current += 1
		previousDraftSourceRef.current = { inputValue, activeQuote, selectedImages, selectedFiles }
	}
	const interactionDraft: InteractionDraft = {
		text: inputValue,
		images: selectedImages,
		files: selectedFiles,
		activeQuote,
		ownerRevision: draftRevisionRef.current,
	}
	const currentTaskIdRef = useRef(taskId)
	const currentDraftRef = useRef(interactionDraft)
	currentTaskIdRef.current = taskId
	currentDraftRef.current = interactionDraft
	const clearOwnedDraft = useCallback(
		(settlement: AcceptedInteractionSettlement): void => {
			if (!canApplyAcceptedInteractionSettlement(currentTaskIdRef.current, currentDraftRef.current, settlement)) {
				return
			}
			setInputValue("")
			setSelectedImages([])
			setSelectedFiles([])
			setActiveQuote(null)
		},
		[setActiveQuote, setInputValue, setSelectedFiles, setSelectedImages],
	)
	// Pairs with clearOwnedDraft: every submit path clears optimistically, so a
	// refused or failed dispatch has to hand the draft back. Restoring is only
	// safe while the composer is still empty; anything typed during the round
	// trip is newer and keeps priority.
	const restoreRejectedDraft = useCallback(
		(settlement: AcceptedInteractionSettlement): void => {
			if (!canRestoreRejectedInteractionDraft(currentTaskIdRef.current, currentDraftRef.current, settlement)) {
				return
			}
			setInputValue(settlement.draft.text)
			setSelectedImages([...settlement.draft.images])
			setSelectedFiles([...settlement.draft.files])
			setActiveQuote(settlement.draft.activeQuote ?? null)
		},
		[setActiveQuote, setInputValue, setSelectedFiles, setSelectedImages],
	)
	const retainSuccessorDraft = useCallback((transfer: PendingSuccessorDraftTransfer): void => {
		setPendingSuccessorDraft(transfer)
	}, [])
	useEffect(() => {
		if (!pendingSuccessorDraft || !taskId || taskId === pendingSuccessorDraft.sourceTaskId) {
			return
		}
		const successorStateStable =
			currentTaskItem?.id === taskId &&
			taskViewState?.taskId === taskId &&
			taskTitleMessage?.text === pendingSuccessorDraft.context
		if (!successorStateStable) {
			return
		}
		restoreDraft(pendingSuccessorDraft.draft)
		setPendingSuccessorDraft(undefined)
	}, [currentTaskItem?.id, pendingSuccessorDraft, restoreDraft, taskId, taskTitleMessage?.text, taskViewState?.taskId])

	useEffect(() => {
		const handleCopy = async (e: ClipboardEvent) => {
			const targetElement = e.target as HTMLElement | null
			// If the copy event originated from an input or textarea,
			// let the default browser behavior handle it.
			if (
				targetElement &&
				(targetElement.tagName === "INPUT" || targetElement.tagName === "TEXTAREA" || targetElement.isContentEditable)
			) {
				return
			}

			if (window.getSelection) {
				const selection = window.getSelection()
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0)
					const commonAncestor = range.commonAncestorContainer
					let textToCopy: string | null = null

					// Check if the selection is inside an element where plain text copy is preferred
					let currentElement =
						commonAncestor.nodeType === Node.ELEMENT_NODE
							? (commonAncestor as HTMLElement)
							: commonAncestor.parentElement
					let preferPlainTextCopy = false
					while (currentElement) {
						if (currentElement.tagName === "PRE" && currentElement.querySelector("code")) {
							preferPlainTextCopy = true
							break
						}
						// Check computed white-space style
						const computedStyle = window.getComputedStyle(currentElement)
						if (
							computedStyle.whiteSpace === "pre" ||
							computedStyle.whiteSpace === "pre-wrap" ||
							computedStyle.whiteSpace === "pre-line"
						) {
							// If the element itself or an ancestor has pre-like white-space,
							// and the selection is likely contained within it, prefer plain text.
							// This helps with elements like the TaskHeader's text display.
							preferPlainTextCopy = true
							break
						}

						// Stop searching if we reach a known chat message boundary or body
						if (
							currentElement.classList.contains("chat-row-assistant-message-container") ||
							currentElement.classList.contains("chat-row-user-message-container") ||
							currentElement.tagName === "BODY"
						) {
							break
						}
						currentElement = currentElement.parentElement
					}

					if (preferPlainTextCopy) {
						// For code blocks or elements with pre-formatted white-space, get plain text.
						textToCopy = selection.toString()
					} else {
						// For other content, use the existing HTML-to-Markdown conversion
						const clonedSelection = range.cloneContents()
						const div = document.createElement("div")
						div.appendChild(clonedSelection)
						const selectedHtml = div.innerHTML
						textToCopy = await convertHtmlToMarkdown(selectedHtml)
					}

					if (textToCopy !== null) {
						try {
							FileServiceClient.copyToClipboard(StringRequest.create({ value: textToCopy })).catch((err) => {
								console.error("Error copying to clipboard:", err)
							})
							e.preventDefault()
						} catch (error) {
							console.error("Error copying to clipboard:", error)
						}
					}
				}
			}
		}
		document.addEventListener("copy", handleCopy)

		return () => {
			document.removeEventListener("copy", handleCopy)
		}
	}, [])
	// Button state is now managed by useButtonState hook

	// handleFocusChange is already provided by chatState

	const { profiles } = useApiProfiles()
	const activeProfile = useMemo(
		() => resolveActiveProfile(profiles, apiConfiguration, mode),
		[profiles, apiConfiguration, mode],
	)
	const { models, defaultModelId } = useProviderModels(activeProfile?.provider ?? "")
	const selectedModelInfo = useMemo(() => {
		if (!activeProfile) {
			return EMPTY_MODEL_INFO
		}
		return resolveProfileModelInfo(activeProfile, { models, defaultModelId })
	}, [activeProfile, models, defaultModelId])
	const displayedApiMetrics = useMemo(
		() => ({
			...(apiMetrics ?? { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 }),
			currency: resolveTaskCurrency(apiMetrics?.currency, selectedModelInfo.pricing?.currency),
		}),
		[apiMetrics, selectedModelInfo.pricing?.currency],
	)

	const selectFilesAndImages = useCallback(async () => {
		try {
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: selectedModelInfo.capabilities?.supportsImages ?? false,
				}),
			)
			if (response?.values1 && response.values2 && (response.values1.length > 0 || response.values2.length > 0)) {
				const currentTotal = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

				if (availableSlots > 0) {
					// Prioritize images first
					const imagesToAdd = Math.min(response.values1.length, availableSlots)
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
					}

					// Use remaining slots for files
					const remainingSlots = availableSlots - imagesToAdd
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
					}
				}
			}
		} catch (error) {
			console.error("Error selecting images & files:", error)
		}
	}, [
		selectedModelInfo.capabilities?.supportsImages,
		setSelectedImages,
		selectedImages.length,
		setSelectedFiles,
		selectedFiles.length,
	])

	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

	// Subscribe to show webview events from the backend
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event) => {
					// Only focus if not hidden and preserveEditorFocus is false
					if (!isHidden && !event.preserveEditorFocus) {
						textAreaRef.current?.focus()
					}
				},
				onError: (error) => {
					console.error("Error in showWebview subscription:", error)
				},
				onComplete: () => {
					console.log("showWebview subscription completed")
				},
			},
		)

		return cleanup
	}, [isHidden, textAreaRef.current?.focus])

	// Set up addToInput subscription
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event) => {
					if (event.value) {
						setInputValue((prevValue) => {
							const newText = event.value
							const newTextWithNewline = `${newText}\n`
							return prevValue ? `${prevValue}\n${newTextWithNewline}` : newTextWithNewline
						})
						// Add scroll to bottom after state update
						// Auto focus the input and start the cursor on a new line for easy typing
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
								textAreaRef.current.focus()
							}
						}, 0)
					}
				},
				onError: (error) => {
					console.error("Error in addToInput subscription:", error)
				},
				onComplete: () => {
					console.log("addToInput subscription completed")
				},
			},
		)

		return cleanup
	}, [setInputValue])

	// Removed: useMount auto-focus and timer auto-focus.
	// Dline must not steal focus from the user's active input
	// (terminal, editor, etc.). Focus is managed explicitly via
	// subscribeToShowWebview (user-triggered) and addToInput (content-driven).

	const visibleMessages = useMemo(() => {
		return filterVisibleMessages(modifiedMessages)
	}, [modifiedMessages])

	const lastProgressMessageText = useMemo(() => {
		if (!focusChainSettings.enabled) {
			return undefined
		}
		return currentFocusChainChecklist || undefined
	}, [focusChainSettings.enabled, currentFocusChainChecklist])

	const showFocusChainPlaceholder = useMemo(() => {
		// Show placeholder whenever focus chain is enabled and no checklist exists yet.
		return focusChainSettings.enabled && !lastProgressMessageText
	}, [focusChainSettings.enabled, lastProgressMessageText])

	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages))
	}, [visibleMessages])

	// Use scroll behavior hook
	const scrollBehavior = useScrollBehavior(messages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)

	// Use message handlers hook (must come after scrollBehavior so we can pass disableAutoScrollRef)
	const messageHandlers = useMessageHandlers(messages, chatState, scrollBehavior.disableAutoScrollRef, taskId)
	const submitInteractionDraft = useCallback(
		async (draft: InteractionDraft): Promise<AcceptedInteractionSettlement | undefined> => {
			if (!taskViewState?.input.enterAction || !interactionSynchronized) {
				return undefined
			}
			const capturedDraft = captureInteractionDraft(draft)
			const request = buildInteractionRequest(taskViewState, taskViewState.input.enterAction, capturedDraft)
			if (!request) {
				return undefined
			}
			const settlement = createAcceptedInteractionSettlement(request, capturedDraft)
			clearOwnedDraft(settlement)
			try {
				const response = await dispatchInteraction(request)
				if (!response.accepted) {
					restoreRejectedDraft(settlement)
					return undefined
				}
				return settlement
			} catch (error: unknown) {
				restoreRejectedDraft(settlement)
				throw error
			}
		},
		[clearOwnedDraft, dispatchInteraction, interactionSynchronized, restoreRejectedDraft, taskViewState],
	)
	const submitOrdinaryTaskDraft = useCallback(
		async (draft: InteractionDraft): Promise<undefined> => {
			const view = taskViewState
			if (!view || view.activeInteraction || view.input.enterAction !== "reply" || !interactionSynchronized) {
				return undefined
			}
			const capturedDraft = captureInteractionDraft(draft)
			// A task without an active interaction has no interaction identity to
			// settle against, so the ask itself is the causal anchor. Reusing the
			// settlement type keeps this path on the same clear/restore contract as
			// the interaction and footer paths instead of clearing inline.
			// This path is guarded to run only without an active interaction, so
			// there is no turn or interaction identity to carry; the empty ids say
			// exactly that. Task and draft identity still gate the rollback.
			const settlement: AcceptedInteractionSettlement = {
				taskId: view.taskId,
				turnId: "",
				interactionId: "",
				stateRevision: view.stateRevision,
				draft: capturedDraft,
			}
			clearOwnedDraft(settlement)
			try {
				await TaskServiceClient.askResponse(
					AskResponseRequest.create({
						responseType: "messageResponse",
						text: capturedDraft.text,
						images: capturedDraft.images,
						files: capturedDraft.files,
					}),
				)
			} catch (error: unknown) {
				restoreRejectedDraft(settlement)
				throw error
			}
			return undefined
		},
		[clearOwnedDraft, interactionSynchronized, restoreRejectedDraft, taskViewState],
	)
	const taskInputEnabled = Boolean(taskViewState?.input.enabled && taskViewState.input.enterAction && interactionSynchronized)
	// The queue is drained at a turn end or a tool round, and only a task that
	// is still working reaches either. Retaining a send after that would hide it
	// in a queue nothing will come back for.
	const queueCanDeliver = taskViewState ? taskPhaseStillDelivers(taskViewState.phase) : false
	const canRenderCompactTask = Boolean(taskViewState?.taskId)
	const canRenderForceTruncate = taskViewState?.forceTruncateAvailable === true
	useEffect(() => {
		if (!contextCompactionActive || !compactCommandPendingRef.current) return
		compactCommandPendingRef.current = false
		setCompactCommandPending(false)
	}, [contextCompactionActive])
	const compactTaskDisabled =
		!taskInputEnabled || contextCompactionActive || compactCommandPending || forceTruncateTaskRpcPending
	const forceTruncateTaskDisabled =
		!taskInputEnabled || contextCompactionActive || compactCommandPending || forceTruncateTaskRpcPending
	const submitCompactTask = useCallback(async (): Promise<boolean> => {
		const view = taskViewState
		if (!view?.taskId || !taskInputEnabled || contextCompactionActive || compactCommandPendingRef.current) {
			return false
		}
		const actionId = view.input.enterAction
		if (!actionId) return false
		const request = buildInteractionRequest(view, actionId, {
			text: MANUAL_COMPACT_COMMAND,
			images: [],
			files: [],
		})
		if (request?.draft?.text !== MANUAL_COMPACT_COMMAND) return false

		compactCommandPendingRef.current = true
		setCompactCommandPending(true)
		let accepted = false
		try {
			const response = await TaskServiceClient.dispatchInteraction(request)
			accepted = response.accepted
			return accepted
		} finally {
			if (!accepted) {
				compactCommandPendingRef.current = false
				setCompactCommandPending(false)
			}
		}
	}, [contextCompactionActive, taskInputEnabled, taskViewState])
	const submitForceTruncateTask = useCallback(async (): Promise<boolean> => {
		if (!taskViewState?.taskId || !taskInputEnabled || contextCompactionActive || forceTruncateTaskRpcPendingRef.current) {
			return false
		}
		forceTruncateTaskRpcPendingRef.current = true
		setForceTruncateTaskRpcPending(true)
		try {
			const response = await TaskServiceClient.compactTask(
				CompactTaskRequest.create({
					forceTruncate: true,
					taskId: taskViewState.taskId,
					stateRevision: taskViewState.stateRevision,
				}),
			)
			return response.accepted
		} finally {
			forceTruncateTaskRpcPendingRef.current = false
			setForceTruncateTaskRpcPending(false)
		}
	}, [contextCompactionActive, taskInputEnabled, taskViewState])
	const submitFollowupOption = useCallback(
		async (message: ClineMessage, option: string): Promise<void> => {
			const view = taskViewState
			const interaction = view?.activeInteraction
			if (
				!view ||
				!interactionSynchronized ||
				interaction?.kind !== "followup" ||
				interaction.taskAsk !== "followup" ||
				interaction.askMessageTs !== message.ts ||
				interaction.interactionId !== message.interactionId ||
				view.input.enterAction !== "reply"
			) {
				return
			}
			const capturedDraft = captureInteractionDraft(currentDraftRef.current)
			const trimmedText = capturedDraft.text.trim()
			const responseDraft = {
				...capturedDraft,
				text: option + (trimmedText ? `: ${trimmedText}` : ""),
			}
			const request = buildInteractionRequest(view, "reply", responseDraft)
			if (!request) return
			const settlement = createAcceptedInteractionSettlement(request, capturedDraft)
			clearOwnedDraft(settlement)
			await TaskServiceClient.dispatchInteraction(request)
		},
		[clearOwnedDraft, interactionSynchronized, taskViewState],
	)

	const placeholderText = useMemo(() => {
		const text = task ? "Type a message..." : "Type your task here..."
		return text
	}, [task])

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="flex flex-col flex-1 overflow-hidden">
				{showNavbar && <Navbar />}
				{task ? (
					<TaskSection
						apiMetrics={displayedApiMetrics}
						compactTaskDisabled={compactTaskDisabled}
						forceTruncateAvailable={canRenderForceTruncate}
						forceTruncateTaskDisabled={forceTruncateTaskDisabled}
						lastApiReqTotalTokens={lastApiReqTotalTokens}
						lastProgressMessageText={lastProgressMessageText}
						messageHandlers={messageHandlers}
						onCompactTask={canRenderCompactTask ? submitCompactTask : undefined}
						onForceTruncateTask={canRenderForceTruncate ? submitForceTruncateTask : undefined}
						selectedModelInfo={{
							contextWindow: selectedModelInfo.capabilities?.contextWindow,
							pricing: selectedModelInfo.pricing,
							supportsPromptCache: selectedModelInfo.capabilities?.supportsPromptCache ?? false,
							supportsImages: selectedModelInfo.capabilities?.supportsImages || false,
						}}
						showFocusChainPlaceholder={showFocusChainPlaceholder}
						task={task}
						taskId={taskViewState?.taskId}
					/>
				) : (
					<WelcomeSection
						hideAnnouncement={hideAnnouncement}
						shouldShowQuickWins={shouldShowQuickWins}
						showAnnouncement={showAnnouncement}
						showHistoryView={showHistoryView}
						taskHistory={taskHistory}
						version={version}
					/>
				)}
				{task && (
					<>
						<TaskActivityTabs activeCount={activeCount} onChange={handleContentTabChange} value={contentTab} />
						{contentTab === "chat" ? (
							<TaskActivityNavigationProvider onNavigate={navigateToActivity}>
								<MessagesArea
									chatState={chatState}
									groupedMessages={groupedMessages}
									messageHandlers={messageHandlers}
									modifiedMessages={modifiedMessages}
									onFollowupOptionSelect={submitFollowupOption}
									scrollBehavior={scrollBehavior}
									task={task}
								/>
							</TaskActivityNavigationProvider>
						) : taskId ? (
							<TaskActivityPanel
								filters={activityFilters}
								focusActivityId={focusedActivityId}
								onFiltersChange={handleActivityFiltersChange}
								taskId={taskId}
							/>
						) : null}
					</>
				)}
			</div>
			<footer className="bg-(--vscode-sidebar-background) flex flex-col gap-[0.375rem] mt-3" style={{ gridRow: "2" }}>
				{task && taskViewState ? (
					<InteractionHost
						dispatch={dispatchInteraction}
						draft={interactionDraft}
						messages={modifiedMessages}
						onDraftAccepted={clearOwnedDraft}
						onDraftRejected={restoreRejectedDraft}
						onSuccessorAccepted={retainSuccessorDraft}
						showTimeline={false}
						view={taskViewState}
					/>
				) : task && !taskViewState ? (
					<div role="alert">Task interaction state is unavailable</div>
				) : null}
				<AutoApproveBar />
				<InputSection
					canQueueInput={queueCanDeliver}
					chatState={chatState}
					clineAsk={taskViewState?.activeInteraction?.taskAsk}
					draft={interactionDraft}
					enabled={task ? taskInputEnabled : undefined}
					inputQueue={inputQueue.entries}
					messageHandlers={messageHandlers}
					onCancelQueuedInput={inputQueue.cancelEdit}
					onCommitQueuedInput={inputQueue.commitEdit}
					onDraftAccepted={clearOwnedDraft}
					onEditQueuedInput={inputQueue.beginEdit}
					onEnqueueInput={inputQueue.enqueue}
					onRemoveQueuedInput={inputQueue.remove}
					onReorderQueuedInput={inputQueue.reorder}
					onSubmit={
						task ? (taskViewState?.activeInteraction ? submitInteractionDraft : submitOrdinaryTaskDraft) : undefined
					}
					onToggleQueuedMode={inputQueue.toggleMode}
					placeholderText={placeholderText}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={
						shouldDisableFilesAndImages ||
						Boolean(
							task &&
								(!taskViewState ||
									!interactionSynchronized ||
									Boolean(
										taskViewState.activeInteraction &&
											!taskViewState.input.acceptsImages &&
											!taskViewState.input.acceptsFiles,
									)),
						)
					}
					submissionIdentity={
						taskViewState?.activeInteraction?.interactionId ?? `draft-${interactionDraft.ownerRevision ?? "unowned"}`
					}
					submissionScope={taskId}
				/>
			</footer>
		</ChatLayout>
	)
}

export default ChatView
