import { flushPendingTaskSettingsRequests } from "@components/settings/utils/settingsHandlers"
import type { ClineAsk } from "@shared/ExtensionMessage"
import React, { useEffect, useRef, useState } from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import { InputQueuePanel, type InputQueuePanelEntry } from "@/components/chat/input/InputQueuePanel"
import type { ModeSwitchDraft } from "@/components/chat/mode-switch/useModeSwitch"
import QuotedMessagePreview from "@/components/chat/QuotedMessagePreview"
import type { AcceptedInteractionSettlement, InteractionDraft } from "@/task-interaction/types"
import { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { resolveSendDisposition } from "./submit-or-enqueue"

interface InputSectionProps {
	chatState: ChatState
	messageHandlers: MessageHandlers
	scrollBehavior: ScrollBehavior
	placeholderText: string
	shouldDisableFilesAndImages: boolean
	selectFilesAndImages: () => Promise<void>
	draft: InteractionDraft
	enabled?: boolean
	onSubmit?: (draft: InteractionDraft) => Promise<AcceptedInteractionSettlement | undefined>
	onDraftAccepted: (settlement: AcceptedInteractionSettlement) => void
	submissionScope?: string
	/** Causal owner used to deduplicate only repeated dispatches of the same submission. */
	submissionIdentity?: string
	clineAsk?: ClineAsk
	/** Queue entries owned by the backend; the composer only renders them. */
	inputQueue?: readonly InputQueuePanelEntry[]
	/**
	 * Whether a blocked send can still be delivered later.
	 *
	 * The queue drains at a turn end or a tool round. A task that will reach
	 * neither has nothing to drain it, so retaining input there would hide it
	 * from the user with no way for it to ever be sent.
	 */
	canQueueInput?: boolean
	/** Receives a send that was blocked because the task is still busy. */
	onEnqueueInput?: (draft: { text: string; images: string[]; files: string[]; activeQuote?: string }) => void
	/** Marks an entry as being edited so it is held back from delivery. */
	onEditQueuedInput?: (id: string) => void
	/** Replaces an edited entry's content, keeping its position and mode. */
	onCommitQueuedInput?: (id: string, draft: { text: string; images: string[]; files: string[]; activeQuote?: string }) => void
	/** Releases an edit without changing the entry, making it deliverable again. */
	onCancelQueuedInput?: (id: string) => void
	onToggleQueuedMode?: (id: string) => void
	onRemoveQueuedInput?: (id: string) => void
	onReorderQueuedInput?: (id: string, targetIndex: number) => void
}

/**
 * Input section including quoted message preview and chat text area
 */
export const InputSection: React.FC<InputSectionProps> = ({
	chatState,
	messageHandlers,
	scrollBehavior,
	placeholderText,
	shouldDisableFilesAndImages,
	selectFilesAndImages,
	draft: currentDraft,
	enabled,
	onSubmit,
	onDraftAccepted,
	submissionScope,
	submissionIdentity,
	clineAsk,
	inputQueue,
	canQueueInput,
	onEnqueueInput,
	onEditQueuedInput,
	onCommitQueuedInput,
	onCancelQueuedInput,
	onToggleQueuedMode,
	onRemoveQueuedInput,
	onReorderQueuedInput,
}) => {
	const {
		activeQuote,
		setActiveQuote,
		isTextAreaFocused,
		inputValue,
		setInputValue,
		undoInputValue,
		redoInputValue,
		sendingDisabled,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		textAreaRef,
		handleFocusChange,
	} = chatState

	const { isAtBottom, scrollToBottomAuto } = scrollBehavior
	// React cannot disable the composer between two DOM events dispatched in the
	// same tick. Claim the causal submission before the first await so a duplicate
	// event cannot dispatch the same draft, while a successor interaction remains
	// independently submitable even if the prior RPC is still settling.
	const directSubmissionsInFlightRef = useRef(new Set<string>())
	const submitDraft = async (capturedDraft?: ModeSwitchDraft) => {
		const directSubmissionKey = `${submissionScope ?? "unscoped"}:${
			submissionIdentity ?? `draft-${currentDraft.ownerRevision ?? "unowned"}`
		}`
		if (directSubmissionsInFlightRef.current.has(directSubmissionKey)) return
		directSubmissionsInFlightRef.current.add(directSubmissionKey)
		try {
			if (submissionScope) await flushPendingTaskSettingsRequests(submissionScope)
			const draft: InteractionDraft = capturedDraft
				? {
						text: capturedDraft.text,
						images: [...capturedDraft.images],
						files: [...capturedDraft.files],
						activeQuote,
						ownerRevision: currentDraft.ownerRevision,
					}
				: currentDraft
			if (!onSubmit) {
				await messageHandlers.handleSendMessage(draft.text, draft.images, draft.files)
				return
			}
			const settlement = await onSubmit(draft)
			if (settlement) {
				onDraftAccepted(settlement)
			}
		} finally {
			directSubmissionsInFlightRef.current.delete(directSubmissionKey)
		}
	}
	// A blocked send is never retained for replay. Re-enabling the composer only
	// means the next explicit send may proceed; it must never resurrect a draft
	// captured while the task was busy. Instead the draft is handed to the queue,
	// which is the only place a blocked send can survive and the only path that
	// can later deliver it.
	// Identifies the entry currently held in the composer. A blocked send while
	// this is set completes that edit rather than adding a second copy of it.
	const [editingEntryId, setEditingEntryId] = useState<string>()

	// The edited entry can disappear underneath the composer: the user may
	// remove it, or the whole task may be switched out. Keeping the id would
	// send the next blocked draft to an entry that no longer exists, silently
	// discarding what the user just typed.
	const editedEntryExists = editingEntryId ? inputQueue?.some((entry) => entry.id === editingEntryId) === true : false
	useEffect(() => {
		if (editingEntryId && !editedEntryExists) {
			setEditingEntryId(undefined)
		}
	}, [editingEntryId, editedEntryExists])

	/**
	 * Clear the composer once a draft has been handed to the queue.
	 *
	 * The queue panel now owns the text, so leaving it in the composer would show
	 * the same input twice and invite an accidental duplicate send.
	 */
	const clearComposerDraft = () => {
		setInputValue("")
		setSelectedImages([])
		setSelectedFiles([])
		setActiveQuote(null)
	}

	// The text last handed to the queue, held until the composer reports a
	// different value. Without it, a send arriving before React has rendered the
	// cleared text area would read the stale value and queue it a second time.
	const handedToQueueRef = useRef<string>()
	if (inputValue !== handedToQueueRef.current) {
		handedToQueueRef.current = undefined
	}

	const enqueueBlockedDraft = (capturedDraft: ModeSwitchDraft) => {
		// The captured text comes from the text area, which still holds the old
		// value until React re-renders with the cleared state. A second send
		// arriving in that window would queue the same draft again, and the
		// composer would keep showing text the queue already owns.
		if (capturedDraft.text === handedToQueueRef.current) {
			return
		}
		const draft = {
			text: capturedDraft.text,
			images: [...capturedDraft.images],
			files: [...capturedDraft.files],
			...(activeQuote ? { activeQuote } : {}),
		}
		// Only commit when the entry is still there; otherwise this is ordinary
		// new input and must be queued rather than dropped.
		if (editingEntryId && editedEntryExists && onCommitQueuedInput) {
			handedToQueueRef.current = capturedDraft.text
			onCommitQueuedInput(editingEntryId, draft)
			setEditingEntryId(undefined)
			clearComposerDraft()
			return
		}
		// Nothing will drain the queue, so the draft stays in the composer where
		// the user can still see it and send it once the task accepts input.
		// The ref is left alone as well, otherwise the retry would be mistaken
		// for a duplicate of a send that never happened.
		if (!onEnqueueInput || !queueCanDeliver) {
			return
		}
		handedToQueueRef.current = capturedDraft.text
		onEnqueueInput(draft)
		clearComposerDraft()
	}

	// Every entry point — the Enter key, the send button and a resume — decides
	// here, so a send behaves the same way whichever one raised it.
	const handleSend = (capturedDraft?: ModeSwitchDraft) => {
		const canSubmit = !(capturedDraft && onSubmit && enabled === false)
		const disposition = resolveSendDisposition({ canSubmit, queueCanDeliver })
		if (disposition === "submit") {
			void submitDraft(capturedDraft)
			return
		}
		// `retain` leaves the draft in the composer: nothing can carry it now,
		// so it stays where the user can still see and resend it.
		if (disposition === "enqueue" && capturedDraft) {
			enqueueBlockedDraft(capturedDraft)
		}
	}

	/**
	 * Whether a send that cannot go out right now may be handed to the queue.
	 *
	 * Defaults to allowed so a caller that does not track task progress keeps
	 * the previous behaviour; only a caller that knows the task is finished
	 * turns it off.
	 */
	const queueCanDeliver = canQueueInput !== false

	// Editing happens in the composer because attaching images or file
	// references is only possible there. The entry keeps its queue position and
	// stays gated until the edit is committed.
	const handleEditQueuedInput = (id: string) => {
		const entry = inputQueue?.find((candidate) => candidate.id === id)
		if (!entry) {
			return
		}
		setInputValue(entry.text)
		setSelectedImages([...entry.images])
		setSelectedFiles([...entry.files])
		// The composer now represents this entry, so an unrelated quote left in
		// it must go: keeping it would attach a quote the entry never had.
		setActiveQuote(entry.activeQuote ?? null)
		setEditingEntryId(id)
		onEditQueuedInput?.(id)
	}

	// Cancelling returns the entry to the queue untouched. The composer keeps
	// whatever the user typed, which is now treated as new input.
	const handleCancelQueuedEdit = (id: string) => {
		if (editingEntryId === id) {
			setEditingEntryId(undefined)
		}
		onCancelQueuedInput?.(id)
	}

	return (
		<>
			{inputQueue && inputQueue.length > 0 && (
				<InputQueuePanel
					entries={inputQueue}
					onCancelEdit={handleCancelQueuedEdit}
					onEdit={handleEditQueuedInput}
					onRemove={(id) => onRemoveQueuedInput?.(id)}
					onReorder={(id, targetIndex) => onReorderQueuedInput?.(id, targetIndex)}
					onToggleMode={(id) => onToggleQueuedMode?.(id)}
				/>
			)}

			{activeQuote && (
				<div style={{ marginBottom: "-12px", marginTop: "10px" }}>
					<QuotedMessagePreview
						isFocused={isTextAreaFocused}
						onDismiss={() => setActiveQuote(null)}
						text={activeQuote}
					/>
				</div>
			)}

			<ChatTextArea
				activeQuote={activeQuote}
				clineAsk={clineAsk}
				inputValue={inputValue}
				onFocusChange={handleFocusChange}
				onHeightChange={() => {
					if (isAtBottom) {
						scrollToBottomAuto()
					}
				}}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={handleSend}
				onSendBlocked={onEnqueueInput ? enqueueBlockedDraft : undefined}
				placeholderText={placeholderText}
				redoInputValue={redoInputValue}
				ref={textAreaRef}
				selectedFiles={selectedFiles}
				selectedImages={selectedImages}
				sendingDisabled={enabled === undefined ? sendingDisabled : !enabled}
				setInputValue={setInputValue}
				setSelectedFiles={setSelectedFiles}
				setSelectedImages={setSelectedImages}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				undoInputValue={undoInputValue}
			/>
		</>
	)
}
