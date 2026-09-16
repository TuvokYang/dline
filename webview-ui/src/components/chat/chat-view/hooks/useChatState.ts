import { ClineMessage } from "@shared/ExtensionMessage"
import { type Dispatch, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { InteractionDraft } from "../../../../task-interaction/types"
import { ChatState } from "../types/chatTypes"

const INPUT_HISTORY_MERGE_INTERVAL_MS = 750
const INPUT_HISTORY_LIMIT = 100

type InputEditKind = "insert" | "delete" | "replace"

interface InputHistory {
	past: string[]
	future: string[]
	lastEditAt?: number
	lastEditKind?: InputEditKind
}

function getInputEditKind(previousValue: string, nextValue: string): InputEditKind {
	if (nextValue.length > previousValue.length) return "insert"
	if (nextValue.length < previousValue.length) return "delete"
	return "replace"
}

function useInputHistory() {
	const [inputValue, setInputValueState] = useState("")
	const inputValueRef = useRef(inputValue)
	const historyRef = useRef<InputHistory>({ past: [], future: [] })

	const setInputValue = useCallback<Dispatch<SetStateAction<string>>>((valueOrUpdater) => {
		const previousValue = inputValueRef.current
		const nextValue = typeof valueOrUpdater === "function" ? valueOrUpdater(previousValue) : valueOrUpdater
		if (nextValue === previousValue) return

		const history = historyRef.current
		const now = Date.now()
		const editKind = getInputEditKind(previousValue, nextValue)
		const canMerge =
			editKind !== "replace" &&
			history.lastEditKind === editKind &&
			history.lastEditAt !== undefined &&
			now - history.lastEditAt <= INPUT_HISTORY_MERGE_INTERVAL_MS

		if (!canMerge) {
			history.past.push(previousValue)
			if (history.past.length > INPUT_HISTORY_LIMIT) {
				history.past.splice(0, history.past.length - INPUT_HISTORY_LIMIT)
			}
		}
		history.future = []
		history.lastEditAt = now
		history.lastEditKind = editKind
		inputValueRef.current = nextValue
		setInputValueState(nextValue)
	}, [])

	const restoreHistoryValue = useCallback((source: "past" | "future"): string | undefined => {
		const history = historyRef.current
		const sourceStack = history[source]
		const nextValue = sourceStack.pop()
		if (nextValue === undefined) return undefined

		const destinationStack = source === "past" ? history.future : history.past
		destinationStack.push(inputValueRef.current)
		inputValueRef.current = nextValue
		history.lastEditAt = undefined
		history.lastEditKind = undefined
		setInputValueState(nextValue)
		return nextValue
	}, [])

	const undoInputValue = useCallback(() => restoreHistoryValue("past"), [restoreHistoryValue])
	const redoInputValue = useCallback(() => restoreHistoryValue("future"), [restoreHistoryValue])
	const resetInputValue = useCallback((value = "") => {
		inputValueRef.current = value
		historyRef.current = { past: [], future: [] }
		setInputValueState(value)
	}, [])

	return { inputValue, setInputValue, undoInputValue, redoInputValue, resetInputValue }
}

/**
 * Custom hook for managing chat state
 * Handles input values, selection states, and UI state
 */
export function useChatState(messages: ClineMessage[], taskId?: string): ChatState {
	// Input and selection state
	const { inputValue, setInputValue, undoInputValue, redoInputValue, resetInputValue } = useInputHistory()
	const [activeQuote, setActiveQuote] = useState<string | null>(null)
	const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
	const [selectedImages, setSelectedImages] = useState<string[]>([])
	const [selectedFiles, setSelectedFiles] = useState<string[]>([])

	// UI state
	const [sendingDisabled, setSendingDisabled] = useState(false)
	const [enableButtons, setEnableButtons] = useState<boolean>(false)
	const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>("Approve")
	const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>("Reject")
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})

	// Refs
	const textAreaRef = useRef<HTMLTextAreaElement>(null)
	const draftOwnerTaskIdRef = useRef(taskId)

	// Message positions are presentation-only and never determine task interaction state.
	const lastMessage = useMemo(() => messages.at(-1), [messages])
	const secondLastMessage = useMemo(() => messages.at(-2), [messages])

	const clearExpandedRows = useCallback(() => {
		setExpandedRows({})
	}, [])

	// Reset state when starting new conversation
	const resetState = useCallback(() => {
		resetInputValue()
		setActiveQuote(null)
		setSelectedImages([])
		setSelectedFiles([])
		setSendingDisabled(false)
	}, [resetInputValue])

	const restoreDraft = useCallback(
		(draft: InteractionDraft) => {
			resetInputValue(draft.text)
			setActiveQuote(draft.activeQuote ?? null)
			setSelectedImages([...draft.images])
			setSelectedFiles([...draft.files])
			setSendingDisabled(false)
		},
		[resetInputValue],
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
				setSelectedImages([])
				setSelectedFiles([])
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
		inputValue,
		setInputValue,
		undoInputValue,
		redoInputValue,
		resetInputValue,
		activeQuote,
		setActiveQuote,
		isTextAreaFocused,
		setIsTextAreaFocused,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
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

		// Refs
		textAreaRef,

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
