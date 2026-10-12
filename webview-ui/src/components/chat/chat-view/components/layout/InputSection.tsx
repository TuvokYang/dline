import { flushPendingTaskSettingsRequests } from "@components/settings/utils/settingsHandlers"
import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import React, { useEffect, useRef, useState } from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import type { ComposerSubmitKind } from "@/components/chat/input/composer-action/composer-action"
import { InputQueuePanel, type InputQueuePanelEntry } from "@/components/chat/input/InputQueuePanel"
import type { ComposerSegment } from "@/components/chat/input/semantic-composer/model"
import type { ComposerSendDraft } from "@/components/chat/input/semantic-composer/send-draft"
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
    /** Whether the active model reads images natively, so the file dialog offers them. */
    imagesAllowed: boolean
    draft: InteractionDraft
    /** The catalog every submission of this view is composed against. */
    semanticCatalog: InputSemanticCatalog
    enabled?: boolean
    onSubmit?: (draft: InteractionDraft) => Promise<AcceptedInteractionSettlement | undefined>
    onDraftAccepted: (settlement: AcceptedInteractionSettlement) => void
    submissionScope?: string
    /** Causal owner used to deduplicate only repeated dispatches of the same submission. */
    submissionIdentity?: string
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
    /** Receives a send that was blocked because the task is still busy; resolves false when refused. */
    onEnqueueInput?: (draft: import("@/components/chat/input/useInputQueue").InputQueueDraft) => Promise<boolean> | void
    /** Marks an entry as being edited so it is held back from delivery. */
    onEditQueuedInput?: (id: string) => void
    /** Replaces an edited entry's content, keeping its position and mode. */
    onCommitQueuedInput?: (
        id: string,
        draft: import("@/components/chat/input/useInputQueue").InputQueueDraft,
    ) => Promise<boolean> | void
    /** Releases an edit without changing the entry, making it deliverable again. */
    onCancelQueuedInput?: (id: string) => void
    onToggleQueuedMode?: (id: string) => void
    onRemoveQueuedInput?: (id: string) => void
    onReorderQueuedInput?: (id: string, targetIndex: number) => void
    /** Stops the running task from the composer's action button; absent while the task offers no cancel. */
    onCancelTask?: () => Promise<void>
    /** What a send from the composer does to the task, shown by its action button. */
    submitKind?: ComposerSubmitKind
    /** The model's output rate while a response streams, which tints the composer's action button. */
    outputTokensPerSecond?: number
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
    imagesAllowed,
    draft: currentDraft,
    semanticCatalog,
    enabled,
    onSubmit,
    onDraftAccepted,
    submissionScope,
    submissionIdentity,
    inputQueue,
    canQueueInput,
    onEnqueueInput,
    onEditQueuedInput,
    onCommitQueuedInput,
    onCancelQueuedInput,
    onToggleQueuedMode,
    onRemoveQueuedInput,
    onReorderQueuedInput,
    onCancelTask,
    submitKind,
    outputTokensPerSecond,
}) => {
    const {
        activeQuote,
        setActiveQuote,
        isTextAreaFocused,
        composer,
        sendingDisabled,
        composerRef,
        handleFocusChange,
        restoreDraft,
    } = chatState

    const { isAtBottom, scrollToBottomAuto } = scrollBehavior
    // React cannot disable the composer between two DOM events dispatched in the
    // same tick. Claim the causal submission before the first await so a duplicate
    // event cannot dispatch the same draft, while a successor interaction remains
    // independently submitable even if the prior RPC is still settling.
    const directSubmissionsInFlightRef = useRef(new Set<string>())
    const submitDraft = async (capturedDraft?: ComposerSendDraft) => {
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
                      ...(capturedDraft.semanticInput === undefined ? {} : { semanticInput: capturedDraft.semanticInput }),
                  }
                : currentDraft
            if (!onSubmit) {
                // A new task adds the quote itself as a literal, so it composes from
                // the frozen draft rather than from a document without the quote.
                await messageHandlers.handleSendMessage({
                    segments: capturedDraft?.segments ?? composer.state.segments,
                    catalog: semanticCatalog,
                })
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
        composer.retire()
        setActiveQuote(null)
    }

    // The draft last handed to the queue, held until the composer holds a
    // different draft. Without it, a second send arriving before the queue
    // acknowledged the first would queue the same draft again, and the composer
    // would keep showing input the queue already owns. Drafts are immutable, so
    // identity is exact: any edit produces a new one.
    const handedToQueueRef = useRef<readonly ComposerSegment[]>()
    if (composer.state.segments !== handedToQueueRef.current) {
        handedToQueueRef.current = undefined
    }

    const enqueueBlockedDraft = (capturedDraft: ComposerSendDraft) => {
        if (capturedDraft.segments === handedToQueueRef.current) {
            return
        }
        const draft = {
            text: capturedDraft.text,
            images: [...capturedDraft.images],
            files: [...capturedDraft.files],
            ...(activeQuote ? { activeQuote } : {}),
            ...(capturedDraft.semanticInput === undefined ? {} : { semanticInput: capturedDraft.semanticInput }),
        }
        // Keep the draft visible until the queue has durably accepted it. The
        // acknowledgement may arrive after the user has edited the composer, so
        // only clear the exact draft that is still pending.
        const clearAcceptedDraft = (result: Promise<boolean> | void, onAccepted?: () => void) => {
            void Promise.resolve(result).then(
                (accepted) => {
                    if (accepted === false) {
                        handedToQueueRef.current = undefined
                        return
                    }
                    if (handedToQueueRef.current !== capturedDraft.segments) {
                        return
                    }
                    onAccepted?.()
                    clearComposerDraft()
                },
                () => {
                    handedToQueueRef.current = undefined
                },
            )
        }
        // Only commit when the entry is still there; otherwise this is ordinary
        // new input and must be queued rather than dropped.
        if (editingEntryId && editedEntryExists && onCommitQueuedInput) {
            handedToQueueRef.current = capturedDraft.segments
            clearAcceptedDraft(onCommitQueuedInput(editingEntryId, draft), () => setEditingEntryId(undefined))
            return
        }
        // Nothing will drain the queue, so the draft stays in the composer where
        // the user can still see it and send it once the task accepts input.
        // The ref is left alone as well, otherwise the retry would be mistaken
        // for a duplicate of a send that never happened. The refusal is shown:
        // a send that leaves no trace reads as lost input.
        if (!onEnqueueInput || !queueCanDeliver) {
            composer.reportSendRefusal("input_not_ready")
            return
        }
        handedToQueueRef.current = capturedDraft.segments
        clearAcceptedDraft(onEnqueueInput(draft))
    }

    // Every entry point — the Enter key, the send button and a resume — decides
    // here, so a send behaves the same way whichever one raised it.
    const handleSend = (capturedDraft?: ComposerSendDraft) => {
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
            return
        }
        if (capturedDraft) composer.reportSendRefusal("input_not_ready")
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
        // The entry comes back with what it still holds back, so an edit cannot
        // complete a pasted fragment into a command. The composer now represents
        // this entry, so an unrelated quote left in it is replaced as well.
        restoreDraft({
            text: entry.text,
            images: [...entry.images],
            files: [...entry.files],
            activeQuote: entry.activeQuote ?? null,
            ...(entry.semanticInput === undefined ? {} : { semanticInput: entry.semanticInput }),
        })
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
                attachmentsDisabled={shouldDisableFilesAndImages}
                composer={composer}
                imagesAllowed={imagesAllowed}
                onCancelTask={onCancelTask}
                onFocusChange={handleFocusChange}
                onHeightChange={() => {
                    if (isAtBottom) {
                        scrollToBottomAuto()
                    }
                }}
                onSend={handleSend}
                onSendBlocked={onEnqueueInput ? enqueueBlockedDraft : undefined}
                outputTokensPerSecond={outputTokensPerSecond}
                placeholderText={placeholderText}
                queueAvailable={queueCanDeliver}
                ref={composerRef}
                semanticCatalog={semanticCatalog}
                sendingDisabled={enabled === undefined ? sendingDisabled : !enabled}
                submitKind={submitKind}
            />
        </>
    )
}
