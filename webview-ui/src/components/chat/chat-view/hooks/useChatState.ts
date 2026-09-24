import { ClineMessage } from "@shared/ExtensionMessage"
import { type Dispatch, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
	EMPTY_PASTE_PROVENANCE,
	type PasteProvenance,
	provenanceForRecalledDraft,
	rebaseProvenance,
} from "@/services/input-semantics/paste-provenance"
import type { InteractionDraft } from "../../../../task-interaction/types"
import { ChatState } from "../types/chatTypes"

const INPUT_HISTORY_MERGE_INTERVAL_MS = 750
const INPUT_HISTORY_LIMIT = 100

type InputEditKind = "insert" | "delete" | "replace"

/**
 * One undoable draft: its text and which characters of it were pasted.
 *
 * Provenance travels with the text it describes (WS-041 AC-09). Keying it by
 * text instead would let a typed draft with the same characters, or an evicted
 * entry, release a pasted command when undo brings it back.
 */
interface HistoryEntry {
	readonly value: string
	readonly provenance: PasteProvenance
}

interface InputHistory {
	past: HistoryEntry[]
	future: HistoryEntry[]
	lastEditAt?: number
	lastEditKind?: InputEditKind
}

function getInputEditKind(previousValue: string, nextValue: string): InputEditKind {
	if (nextValue.length > previousValue.length) return "insert"
	if (nextValue.length < previousValue.length) return "delete"
	return "replace"
}

/**
 * The composer draft with its undo history and paste provenance.
 *
 * The composer commits provenance for every edit it observes; any other change
 * of text is followed by rebasing the last commit. Undo and redo restore the
 * provenance recorded with the entry, and an ownership reset clears it.
 */
function useInputHistory() {
	const [inputValue, setInputValueState] = useState("")
	const [storedProvenance, setStoredProvenance] = useState<PasteProvenance>(EMPTY_PASTE_PROVENANCE)
	const inputValueRef = useRef(inputValue)
	const provenanceRef = useRef(storedProvenance)
	// Some edits commit provenance for their new text before setting it; this
	// keeps what held for the text being replaced, so its undo entry is exact.
	const replacedProvenanceRef = useRef<PasteProvenance>()
	const historyRef = useRef<InputHistory>({ past: [], future: [] })

	const currentEntry = useCallback((): HistoryEntry => {
		const value = inputValueRef.current
		const committed = provenanceRef.current
		const replaced = replacedProvenanceRef.current
		const provenance =
			committed.text === value ? committed : replaced?.text === value ? replaced : rebaseProvenance(committed, value)
		return { value, provenance }
	}, [])

	const commitPasteProvenance = useCallback((provenance: PasteProvenance) => {
		const value = inputValueRef.current
		replacedProvenanceRef.current = provenance.text === value ? undefined : rebaseProvenance(provenanceRef.current, value)
		provenanceRef.current = provenance
		setStoredProvenance(provenance)
	}, [])

	const setInputValue = useCallback<Dispatch<SetStateAction<string>>>(
		(valueOrUpdater) => {
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
				history.past.push(currentEntry())
				if (history.past.length > INPUT_HISTORY_LIMIT) {
					history.past.splice(0, history.past.length - INPUT_HISTORY_LIMIT)
				}
			}
			history.future = []
			history.lastEditAt = now
			history.lastEditKind = editKind
			inputValueRef.current = nextValue
			setInputValueState(nextValue)
		},
		[currentEntry],
	)

	const restoreHistoryValue = useCallback(
		(source: "past" | "future"): string | undefined => {
			const history = historyRef.current
			const entry = history[source].pop()
			if (entry === undefined) return undefined

			const destinationStack = source === "past" ? history.future : history.past
			destinationStack.push(currentEntry())
			inputValueRef.current = entry.value
			history.lastEditAt = undefined
			history.lastEditKind = undefined
			setInputValueState(entry.value)
			commitPasteProvenance(entry.provenance)
			return entry.value
		},
		[commitPasteProvenance, currentEntry],
	)

	const undoInputValue = useCallback(() => restoreHistoryValue("past"), [restoreHistoryValue])
	const redoInputValue = useCallback(() => restoreHistoryValue("future"), [restoreHistoryValue])
	const resetInputValue = useCallback(
		(value = "") => {
			inputValueRef.current = value
			historyRef.current = { past: [], future: [] }
			setInputValueState(value)
			// A new owner starts with nothing pasted; a restored draft recommits its own.
			commitPasteProvenance({ text: value, spans: [] })
		},
		[commitPasteProvenance],
	)

	const pasteProvenance = useMemo(() => rebaseProvenance(storedProvenance, inputValue), [storedProvenance, inputValue])

	return {
		inputValue,
		setInputValue,
		undoInputValue,
		redoInputValue,
		resetInputValue,
		pasteProvenance,
		commitPasteProvenance,
	}
}

/**
 * Custom hook for managing chat state
 * Handles input values, selection states, and UI state
 */
export function useChatState(messages: ClineMessage[], taskId?: string): ChatState {
	// Input and selection state
	const { inputValue, setInputValue, undoInputValue, redoInputValue, resetInputValue, pasteProvenance, commitPasteProvenance } =
		useInputHistory()
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
			// A restored draft may hold pasted text; releasing it would let an
			// edit complete it into a command the user never chose (WS-041 AC-09).
			commitPasteProvenance(provenanceForRecalledDraft(draft.text, draft.semanticInput))
			setActiveQuote(draft.activeQuote ?? null)
			setSelectedImages([...draft.images])
			setSelectedFiles([...draft.files])
			setSendingDisabled(false)
		},
		[commitPasteProvenance, resetInputValue],
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
		pasteProvenance,
		commitPasteProvenance,
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
