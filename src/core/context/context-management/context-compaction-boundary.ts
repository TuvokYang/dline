import type {
	ClineAssistantToolUseBlock,
	ClineContent,
	ClineStorageMessage,
	ClineTextContentBlock,
	ClineUserToolResultContentBlock,
} from "@shared/messages/content"
import cloneDeep from "clone-deep"
import type { CanonicalMessageRange } from "./compaction-context-projection"
import { indexLogicalTurns } from "./logical-turns"

export interface ContextCompactionBoundary {
	sourceHistory: ClineStorageMessage[]
	sourceCanonicalRanges: Array<CanonicalMessageRange | undefined>
	targetContinuationHistory: ClineStorageMessage[]
}

export interface ContextCompactionBoundaryOptions {
	/** Decide whether an unpaired tool use may receive neutral identity-only pairing evidence in the hidden Pass. */
	shouldCompleteUnpairedToolUse?: (toolUse: ClineAssistantToolUseBlock) => boolean
}

/**
 * Project a self-contained compaction source while pending request content remains outside canonical history.
 *
 * Pending tool results participate in logical-turn boundary discovery. A result that closes the latest canonical
 * turn makes that complete turn eligible for the hidden Pass, while the unsent result still belongs to the ordinary
 * continuation. Tagged conversational feedback starts the next user-authored round, so its real text stays outside
 * the hidden Pass; neutral pairing evidence keeps the selected source provider-projectable without consuming it.
 */
export function projectContextCompactionBoundary(
	activeHistory: readonly ClineStorageMessage[],
	pendingContent: readonly ClineContent[],
	options: ContextCompactionBoundaryOptions = {},
	activeCanonicalRanges: readonly (CanonicalMessageRange | undefined)[] = activeHistory.map(() => undefined),
): ContextCompactionBoundary {
	if (activeCanonicalRanges.length !== activeHistory.length) {
		throw new Error("Context compaction canonical range mapping must align with active history")
	}
	const pendingBlocks = pendingContent.filter(
		(block): block is ClineUserToolResultContentBlock | ClineTextContentBlock =>
			block.type === "tool_result" || block.type === "text",
	)
	const completedUnpairedFunctionIds = options.shouldCompleteUnpairedToolUse
		? collectCompletableUnpairedFunctionIds(activeHistory, options.shouldCompleteUnpairedToolUse)
		: new Set<string>()
	const activeBoundary = options.shouldCompleteUnpairedToolUse
		? completePendingPairings(activeHistory, activeCanonicalRanges, [], options.shouldCompleteUnpairedToolUse)
		: { messages: cloneDeep([...activeHistory]), canonicalRanges: [...activeCanonicalRanges] }
	const activeBoundaryHistory = activeBoundary.messages
	const pendingMessage: ClineStorageMessage | undefined =
		pendingBlocks.length > 0 ? { role: "user", content: cloneDeep(pendingBlocks), ts: Date.now() } : undefined
	const activeIndex = indexLogicalTurns(activeBoundaryHistory)
	const boundaryHistory = pendingMessage ? [...activeBoundaryHistory, pendingMessage] : activeBoundaryHistory
	const boundaryIndex = indexLogicalTurns(boundaryHistory)
	const pendingResultFunctionIds = new Set(
		pendingBlocks
			.filter((block): block is ClineUserToolResultContentBlock => block.type === "tool_result")
			.map((block) => block.function_id),
	)
	const pendingCompletesProtectedTurn =
		activeIndex.turns.length > 0 &&
		activeIndex.protectedStartMessageIndex < activeBoundaryHistory.length &&
		activeIndex.issues.some((issue) => issue.kind === "unpaired_tool_use" && pendingResultFunctionIds.has(issue.functionId))
	const pendingStartsProtectedRound =
		pendingMessage !== undefined && boundaryIndex.protectedStartMessageIndex === activeBoundaryHistory.length
	// The logical-turn index identifies tagged user feedback as a new protected round.
	// Ordinary tool results close the current turn at the end of the boundary view.
	const sourceEndIndex =
		pendingCompletesProtectedTurn && pendingStartsProtectedRound
			? activeIndex.protectedStartMessageIndex
			: Math.min(boundaryIndex.protectedStartMessageIndex, boundaryHistory.length)
	const sourceHistory = boundaryHistory.slice(0, sourceEndIndex)
	const boundaryCanonicalRanges = pendingMessage
		? [...activeBoundary.canonicalRanges, undefined]
		: activeBoundary.canonicalRanges
	const sourceCanonicalRanges = boundaryCanonicalRanges.slice(0, sourceEndIndex)
	// Tool results in the protected tail may close a source tool use without making
	// their user-authored payload eligible for the hidden Pass. The pairing helper
	// consumes only identity and emits neutral evidence, while the real result stays
	// in the ordinary continuation owned by the upcoming request.
	const sourcePairingEvidence = [...collectToolResults(activeBoundaryHistory.slice(sourceEndIndex)), ...pendingBlocks]

	// Tagged conversational feedback starts a new protected round and still needs
	// the declaring tool use for provider pairing. Plain side-effect results instead
	// make the completed turn fully replaceable by the accepted summary.
	const naturalContinuationStart =
		pendingCompletesProtectedTurn && pendingStartsProtectedRound
			? activeIndex.protectedStartMessageIndex
			: Math.min(sourceEndIndex, activeHistory.length)
	const targetContinuationHistory = activeHistory.filter(
		(message, messageIndex) =>
			messageIndex >= naturalContinuationStart ||
			messageContainsToolUse(message, completedUnpairedFunctionIds) ||
			(pendingStartsProtectedRound && messageContainsToolUse(message, pendingResultFunctionIds)),
	)

	const completedSource = completePendingPairings(
		sourceHistory,
		sourceCanonicalRanges,
		sourcePairingEvidence,
		options.shouldCompleteUnpairedToolUse,
	)
	return {
		sourceHistory: completedSource.messages,
		sourceCanonicalRanges: completedSource.canonicalRanges,
		targetContinuationHistory: cloneDeep(targetContinuationHistory),
	}
}

function collectCompletableUnpairedFunctionIds(
	history: readonly ClineStorageMessage[],
	shouldComplete: (toolUse: ClineAssistantToolUseBlock) => boolean,
): Set<string> {
	const toolUses = collectToolUses(history)
	return new Set(
		indexLogicalTurns(cloneDeep([...history])).issues.flatMap((issue) => {
			if (issue.kind !== "unpaired_tool_use") return []
			const toolUse = toolUses.get(issue.functionId)
			return toolUse && shouldComplete(toolUse) ? [issue.functionId] : []
		}),
	)
}

function messageContainsToolUse(message: ClineStorageMessage, functionIds: ReadonlySet<string>): boolean {
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "tool_use" && functionIds.has(block.function_id))
	)
}

/** Materialize only the identity-level pairing evidence required by the selected hidden-Pass source. */
function completePendingPairings(
	sourceHistory: readonly ClineStorageMessage[],
	sourceCanonicalRanges: readonly (CanonicalMessageRange | undefined)[],
	pendingBlocks: readonly (ClineUserToolResultContentBlock | ClineTextContentBlock)[],
	shouldCompleteUnpairedToolUse?: (toolUse: ClineAssistantToolUseBlock) => boolean,
): { messages: ClineStorageMessage[]; canonicalRanges: Array<CanonicalMessageRange | undefined> } {
	const source: ClineStorageMessage[] = cloneDeep([...sourceHistory])
	const canonicalRanges = [...sourceCanonicalRanges]
	const sourceIndex = indexLogicalTurns(source)
	const pendingResults = new Map(
		pendingBlocks
			.filter((block): block is ClineUserToolResultContentBlock => block.type === "tool_result")
			.map((block) => [block.function_id, block] as const),
	)
	const sourceToolUses = collectToolUses(source)

	const pairingResults = sourceIndex.issues.flatMap((issue): ClineUserToolResultContentBlock[] => {
		if (issue.kind !== "unpaired_tool_use") return []
		const pendingResult = pendingResults.get(issue.functionId)
		const toolUse = sourceToolUses.get(issue.functionId)
		if (!toolUse || (!pendingResult && !shouldCompleteUnpairedToolUse?.(toolUse))) return []
		return [
			{
				type: "tool_result",
				function_id: pendingResult?.function_id ?? toolUse.function_id,
				dline_tid: pendingResult?.dline_tid ?? toolUse.dline_tid,
				content: [{ type: "text", text: `Tool ${toolUse.name} executed successfully.` }],
			},
		]
	})
	if (pairingResults.length === 0) return { messages: source, canonicalRanges }

	return {
		messages: [...source, { role: "user", content: pairingResults }],
		canonicalRanges: [...canonicalRanges, undefined],
	}
}

function collectToolResults(history: readonly ClineStorageMessage[]): ClineUserToolResultContentBlock[] {
	return history.flatMap((message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) return []
		return message.content.filter((block): block is ClineUserToolResultContentBlock => block.type === "tool_result")
	})
}

function collectToolUses(history: readonly ClineStorageMessage[]): Map<string, ClineAssistantToolUseBlock> {
	const toolUses = new Map<string, ClineAssistantToolUseBlock>()
	for (const message of history) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block.type === "tool_use") toolUses.set(block.function_id, block)
		}
	}
	return toolUses
}
