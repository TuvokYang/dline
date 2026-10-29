import { UiMessage } from "@shared/ExtensionMessage"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { InteractionDraft } from "../../../../task-interaction/types"
import { stageLegacyAttachments } from "../../input/semantic-composer/resource-staging"
import { segmentsForRecalledDraft } from "../../input/semantic-composer/restore"
import type { SemanticComposerEditorHandle } from "../../input/semantic-composer/SemanticComposerEditor"
import { useComposerDraft } from "../../input/semantic-composer/useComposerDraft"
import { ChatState } from "../types/chatTypes"

/**
 * Custom hook for managing chat state
 * Handles input values, selection states, and UI state
 */
export function useChatState(messages: UiMessage[], taskId?: string): ChatState {
    // The composer draft owns text, entities, resources and undo history (WS-041).
    const composer = useComposerDraft()
    const [activeQuote, setActiveQuote] = useState<string | null>(null)
    const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)

    // UI state
    const [sendingDisabled, setSendingDisabled] = useState(false)
    const [enableButtons, setEnableButtons] = useState<boolean>(false)
    const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>("Approve")
    const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>("Reject")
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
    // Fold ids are not message timestamps, so fold expansion has a key space of its own.
    const [expandedFolds, setExpandedFolds] = useState<Record<string, boolean>>({})

    // Refs
    const composerRef = useRef<SemanticComposerEditorHandle>(null)
    const draftOwnerTaskIdRef = useRef(taskId)

    // Message positions are presentation-only and never determine task interaction state.
    const lastMessage = useMemo(() => messages.at(-1), [messages])
    const secondLastMessage = useMemo(() => messages.at(-2), [messages])

    const clearExpandedRows = useCallback(() => {
        setExpandedRows({})
        setExpandedFolds({})
    }, [])

    // Reset state when starting new conversation
    const { clear: clearComposer, load: loadComposer } = composer
    const resetState = useCallback(() => {
        clearComposer()
        setActiveQuote(null)
        setSendingDisabled(false)
    }, [clearComposer])

    const { engine } = composer
    const restoreDraft = useCallback(
        (draft: InteractionDraft) => {
            // Only entities the document confirmed come back live; everything else
            // comes back held, so no edit can complete it into a command (WS-041 AC-09).
            const { draftId } = loadComposer(segmentsForRecalledDraft(draft.text, draft.semanticInput))
            setActiveQuote(draft.activeQuote ?? null)
            setSendingDisabled(false)
            // Flat attachments come back as resources staged at the end of the
            // draft that recalled them, never of the draft it replaced.
            if (draft.images.length > 0 || draft.files.length > 0) {
                void stageLegacyAttachments(engine, draftId, draft.images, draft.files)
            }
        },
        [engine, loadComposer],
    )

    // Handle focus change
    const handleFocusChange = useCallback((isFocused: boolean) => {
        setIsTextAreaFocused(isFocused)
    }, [])

    // Settle draft ownership before paint so a newly interactive composer cannot
    // accept text that a later passive ownership reset would clear.
    useLayoutEffect(() => {
        if (draftOwnerTaskIdRef.current !== taskId) {
            const preservesSubmittedWelcomeHistory =
                draftOwnerTaskIdRef.current === undefined && taskId !== undefined && sendingDisabled
            draftOwnerTaskIdRef.current = taskId
            if (preservesSubmittedWelcomeHistory) {
                setActiveQuote(null)
                setSendingDisabled(false)
            } else {
                resetState()
            }
        }
    }, [resetState, sendingDisabled, taskId])

    useEffect(() => {
        clearExpandedRows()
    }, [clearExpandedRows, taskId])

    return {
        // State values
        composer,
        inputValue: composer.flatText,
        setInputValue: composer.setText,
        activeQuote,
        setActiveQuote,
        isTextAreaFocused,
        setIsTextAreaFocused,
        sendingDisabled,
        setSendingDisabled,
        enableButtons,
        setEnableButtons,
        primaryButtonText,
        setPrimaryButtonText,
        secondaryButtonText,
        setSecondaryButtonText,
        expandedRows,
        setExpandedRows,
        expandedFolds,
        setExpandedFolds,

        // Refs
        composerRef,

        // Derived values
        lastMessage,
        secondLastMessage,

        // Handlers
        handleFocusChange,
        clearExpandedRows,
        resetState,
        restoreDraft,
    }
}
