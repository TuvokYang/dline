import type { ClineAssistantToolUseBlock, ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages/content"
import cloneDeep from "clone-deep"
import { hashCompactionSummary, hashCompactionValue } from "./compaction-hash"
import {
	type CompactionSourceSnapshot,
	materializeCompactionSourceRange,
	materializeCompactionSourceSuffix,
} from "./compaction-source-snapshot"
import { compactionSummaryMessage } from "./compaction-summary-message"
import type { LogicalTurnIndex, LogicalTurnSpan } from "./logical-turns"

export interface CompactionPassIdentity {
	operationId: string
	passIndex: number
	passStartTurnIndex: number
	passEndTurnIndex: number
	coveredTurnCount: number
	summaryBaselineHash: string
	/** Hash of the immutable source-message baseline indexed for this operation. */
	sourceHistoryHash?: string
	/** Inclusive coordinates in the immutable source-message baseline. */
	passStartMessageIndex?: number
	passEndMessageIndex?: number
	/** Hash binding the source baseline to both Pass coordinate systems and exact source messages. */
	rangeHash?: string
	passHistoryHash?: string
}

export interface CompactionPassSelection extends CompactionPassIdentity {
	estimatedInputTokens: number
	passInputCeiling: number
	passHistoryHash: string
	requestEnvelopeTokens?: number
	summaryCarryTokens?: number
	turnTokens?: number
	combinedEstimatedInputTokens?: number
	candidateEstimateCount?: number
	nextPassSummaryCarryLimitTokens?: number
}

export interface TargetWindowFittingState extends CompactionPassIdentity {
	sourceHistoryHash: string
	passStartMessageIndex?: number
	passEndMessageIndex?: number
	readonly sourceSnapshot: CompactionSourceSnapshot
	readonly turns: readonly LogicalTurnSpan[]
	readonly protectedStartMessageIndex: number
	cumulativeSummary?: string
	estimatedInputTokens?: number
	passInputCeiling?: number
	passHistoryHash?: string
	requestEnvelopeTokens?: number
	summaryCarryTokens?: number
	turnTokens?: number
	combinedEstimatedInputTokens?: number
	candidateEstimateCount?: number
	nextPassSummaryCarryLimitTokens?: number
	passPlanned: boolean
}

export interface AcceptedCompactionPass {
	state: TargetWindowFittingState
	coveredTurnCount: number
	hasMoreTurns: boolean
}

/** Start rolling fitting only when canonical history contains a complete logical turn. */
export function tryStartTargetWindowFitting(
	index: LogicalTurnIndex,
	operationId: string,
	sourceSnapshot: CompactionSourceSnapshot,
): TargetWindowFittingState | undefined {
	return index.turns.length === 0 ? undefined : startTargetWindowFitting(index, operationId, sourceSnapshot)
}

/** Start fitting from the earliest complete logical turn. */
export function startTargetWindowFitting(
	index: LogicalTurnIndex,
	operationId: string,
	sourceSnapshot: CompactionSourceSnapshot,
): TargetWindowFittingState {
	if (index.turns.length === 0) {
		throw new Error("No complete logical turn is available for compaction")
	}
	if (!operationId.trim()) {
		throw new Error("Compaction operation ID must be non-empty")
	}
	if (index.protectedStartMessageIndex > sourceSnapshot.messages.length) {
		throw new Error("Compaction logical-turn index exceeds the source snapshot")
	}
	return {
		operationId,
		passIndex: 0,
		summaryBaselineHash: hashSummaryBaseline(""),
		sourceHistoryHash: sourceSnapshot.sourceHistoryHash,
		sourceSnapshot,
		turns: index.turns,
		protectedStartMessageIndex: index.protectedStartMessageIndex,
		coveredTurnCount: 0,
		passStartTurnIndex: 0,
		passEndTurnIndex: -1,
		passStartMessageIndex: 0,
		passEndMessageIndex: -1,
		passPlanned: false,
	}
}

/** Apply one immutable planner result without advancing accepted logical-turn coverage. */
export function applyCompactionPassPlan(
	state: TargetWindowFittingState,
	plan: CompactionPassSelection,
): TargetWindowFittingState {
	if (plan.operationId !== state.operationId || plan.passIndex !== state.passIndex) {
		throw new Error("Compaction Pass plan does not belong to the active operation and Pass")
	}
	if (plan.coveredTurnCount !== state.coveredTurnCount || plan.passStartTurnIndex !== state.coveredTurnCount) {
		throw new Error("Compaction Pass plan does not start at the earliest uncovered logical turn")
	}
	if (plan.passEndTurnIndex < plan.passStartTurnIndex || plan.passEndTurnIndex >= state.turns.length) {
		throw new Error("Compaction Pass plan has an invalid logical-turn range")
	}
	if (plan.summaryBaselineHash !== state.summaryBaselineHash) {
		throw new Error("Compaction Pass plan summary baseline is stale")
	}
	const rangeIdentity = createCompactionPassRangeIdentity(state, plan.passStartTurnIndex, plan.passEndTurnIndex)
	const suppliedRange =
		plan.sourceHistoryHash !== undefined ||
		plan.passStartMessageIndex !== undefined ||
		plan.passEndMessageIndex !== undefined ||
		plan.rangeHash !== undefined
	if (
		suppliedRange &&
		(plan.sourceHistoryHash !== rangeIdentity.sourceHistoryHash ||
			plan.passStartMessageIndex !== rangeIdentity.passStartMessageIndex ||
			plan.passEndMessageIndex !== rangeIdentity.passEndMessageIndex ||
			plan.rangeHash !== rangeIdentity.rangeHash)
	) {
		throw new Error("Compaction Pass plan source-message range is stale or invalid")
	}
	return {
		...state,
		passStartTurnIndex: plan.passStartTurnIndex,
		passEndTurnIndex: plan.passEndTurnIndex,
		passStartMessageIndex: rangeIdentity.passStartMessageIndex,
		passEndMessageIndex: rangeIdentity.passEndMessageIndex,
		rangeHash: rangeIdentity.rangeHash,
		estimatedInputTokens: plan.estimatedInputTokens,
		passInputCeiling: plan.passInputCeiling,
		passHistoryHash: plan.passHistoryHash,
		requestEnvelopeTokens: plan.requestEnvelopeTokens ?? state.requestEnvelopeTokens,
		summaryCarryTokens: plan.summaryCarryTokens,
		turnTokens: plan.turnTokens,
		combinedEstimatedInputTokens: plan.combinedEstimatedInputTokens ?? plan.estimatedInputTokens,
		candidateEstimateCount: plan.candidateEstimateCount,
		nextPassSummaryCarryLimitTokens: plan.nextPassSummaryCarryLimitTokens,
		passPlanned: true,
	}
}

/** Build only the selected complete turns, excluding the cumulative summary carry. */
export function buildCompactionTurnHistoryForRange(
	state: TargetWindowFittingState,
	passStartTurnIndex: number,
	passEndTurnIndex: number,
): ClineStorageMessage[] {
	const passTurns = state.turns.slice(passStartTurnIndex, passEndTurnIndex + 1)
	if (passTurns.length === 0) {
		throw new Error("Compaction Pass has no uncovered logical turn")
	}
	const turnHistory = materializeCompactionSourceRange(
		state.sourceSnapshot,
		passTurns[0].startMessageIndex,
		passTurns[passTurns.length - 1].endMessageIndex,
	)
	return completePassToolPairing(turnHistory)
}

/**
 * Close every tool use the selected Pass range leaves unpaired.
 *
 * A tagged conversational tool result both closes its call and opens the next
 * user-authored round, so the logical-turn index deliberately assigns it to the
 * following turn. A Pass ending on such a boundary would otherwise project a
 * provider `function_call` without its `function_call_output`, which the
 * Responses API rejects with "No tool output found for function call". The real
 * result stays outside this Pass; only neutral identity-level pairing evidence
 * is appended so the hidden request remains provider-projectable.
 */
function completePassToolPairing(passHistory: ClineStorageMessage[]): ClineStorageMessage[] {
	const openToolUses = new Map<string, ClineAssistantToolUseBlock>()
	for (const message of passHistory) {
		if (!Array.isArray(message.content)) continue
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "tool_use") openToolUses.set(block.function_id, block)
			}
			continue
		}
		for (const block of message.content) {
			if (block.type === "tool_result") openToolUses.delete(block.function_id)
		}
	}
	if (openToolUses.size === 0) return passHistory

	const pairingResults: ClineUserToolResultContentBlock[] = [...openToolUses.values()].map((toolUse) => ({
		type: "tool_result",
		function_id: toolUse.function_id,
		dline_tid: toolUse.dline_tid,
		content: [{ type: "text", text: `Tool ${toolUse.name} executed successfully.` }],
	}))
	return [...passHistory, { role: "user", content: pairingResults }]
}

/** Build the exact canonical history included in one candidate hidden compaction Pass range. */
export function buildCompactionPassHistoryForRange(
	state: TargetWindowFittingState,
	passStartTurnIndex: number,
	passEndTurnIndex: number,
): ClineStorageMessage[] {
	return [
		...(state.cumulativeSummary ? [compactionSummaryMessage(state.cumulativeSummary)] : []),
		...buildCompactionTurnHistoryForRange(state, passStartTurnIndex, passEndTurnIndex),
	]
}

/** Build the exact canonical history included in the planned hidden compaction Pass. */
export function buildCompactionPassHistory(state: TargetWindowFittingState): ClineStorageMessage[] {
	if (!state.passPlanned) {
		throw new Error("Compaction Pass must be planned before building its history")
	}
	return buildCompactionPassHistoryForRange(state, state.passStartTurnIndex, state.passEndTurnIndex)
}

/**
 * Whether a planned Pass is part of an iterative compaction: a later Pass of the operation, or a first
 * Pass that leaves turns for later Passes. Such a Pass sees only part of the task, so its checklist must
 * not replace the task progress.
 */
export function isIterativeCompactionPass(state: TargetWindowFittingState): boolean {
	return state.passIndex > 0 || state.passEndTurnIndex < state.turns.length - 1
}

/** Accept one valid cumulative summary and advance coverage to the next complete turn. */
export function acceptCompactionPass(state: TargetWindowFittingState, summary: string): AcceptedCompactionPass {
	if (!state.passPlanned) {
		throw new Error("Compaction Pass must be planned before accepting its summary")
	}
	const cumulativeSummary = summary.trim()
	if (!cumulativeSummary) {
		throw new Error("Compaction summary must be non-empty")
	}
	const coveredTurnCount = state.passEndTurnIndex + 1
	if (coveredTurnCount <= state.coveredTurnCount) {
		throw new Error("Compaction Pass did not advance logical-turn coverage")
	}
	const hasMoreTurns = coveredTurnCount < state.turns.length
	return {
		coveredTurnCount,
		hasMoreTurns,
		state: {
			...state,
			passIndex: state.passIndex + 1,
			summaryBaselineHash: hashSummaryBaseline(cumulativeSummary),
			coveredTurnCount,
			passStartTurnIndex: coveredTurnCount,
			passEndTurnIndex: coveredTurnCount - 1,
			passStartMessageIndex: state.turns[coveredTurnCount]?.startMessageIndex ?? state.protectedStartMessageIndex,
			passEndMessageIndex: (state.turns[coveredTurnCount]?.startMessageIndex ?? state.protectedStartMessageIndex) - 1,
			rangeHash: undefined,
			cumulativeSummary,
			estimatedInputTokens: undefined,
			passInputCeiling: undefined,
			passHistoryHash: undefined,
			summaryCarryTokens: undefined,
			turnTokens: undefined,
			combinedEstimatedInputTokens: undefined,
			candidateEstimateCount: undefined,
			nextPassSummaryCarryLimitTokens: state.nextPassSummaryCarryLimitTokens,
			passPlanned: false,
		},
	}
}

/** Replace only the cumulative summary after a bounded refit without advancing logical-turn coverage. */
export function refitCompactionSummary(state: TargetWindowFittingState, summary: string): TargetWindowFittingState {
	if (!state.cumulativeSummary) {
		throw new Error("Compaction summary refit requires an existing cumulative summary")
	}
	const cumulativeSummary = summary.trim()
	if (!cumulativeSummary) {
		throw new Error("Refitted compaction summary must be non-empty")
	}
	if (Buffer.byteLength(cumulativeSummary, "utf8") >= Buffer.byteLength(state.cumulativeSummary, "utf8")) {
		throw new Error("Refitted compaction summary must be strictly smaller than the previous summary")
	}
	return {
		...state,
		summaryBaselineHash: hashSummaryBaseline(cumulativeSummary),
		cumulativeSummary,
		estimatedInputTokens: undefined,
		passInputCeiling: undefined,
		passHistoryHash: undefined,
		requestEnvelopeTokens: undefined,
		summaryCarryTokens: undefined,
		turnTokens: undefined,
		combinedEstimatedInputTokens: undefined,
		candidateEstimateCount: undefined,
		passPlanned: false,
	}
}

/** Compare two Pass identities by field value so key order can never affect staleness checks. */
export function areCompactionPassIdentitiesEqual(left: CompactionPassIdentity, right: CompactionPassIdentity): boolean {
	return (
		left.operationId === right.operationId &&
		left.passIndex === right.passIndex &&
		left.passStartTurnIndex === right.passStartTurnIndex &&
		left.passEndTurnIndex === right.passEndTurnIndex &&
		left.coveredTurnCount === right.coveredTurnCount &&
		left.summaryBaselineHash === right.summaryBaselineHash &&
		left.sourceHistoryHash === right.sourceHistoryHash &&
		left.passStartMessageIndex === right.passStartMessageIndex &&
		left.passEndMessageIndex === right.passEndMessageIndex &&
		left.rangeHash === right.rangeHash &&
		left.passHistoryHash === right.passHistoryHash
	)
}

/** Return the immutable identity of the current Pass plan. */
export function getCompactionPassIdentity(state: TargetWindowFittingState): CompactionPassIdentity {
	return {
		operationId: state.operationId,
		passIndex: state.passIndex,
		passStartTurnIndex: state.passStartTurnIndex,
		passEndTurnIndex: state.passEndTurnIndex,
		coveredTurnCount: state.coveredTurnCount,
		summaryBaselineHash: state.summaryBaselineHash,
		sourceHistoryHash: state.sourceHistoryHash,
		passStartMessageIndex: state.passStartMessageIndex,
		passEndMessageIndex: state.passEndMessageIndex,
		rangeHash: state.rangeHash,
		passHistoryHash: state.passHistoryHash,
	}
}

/** Bind one logical-turn selection to its exact immutable source-message coordinates. */
export function createCompactionPassRangeIdentity(
	state: TargetWindowFittingState,
	passStartTurnIndex: number,
	passEndTurnIndex: number,
): Required<Pick<CompactionPassIdentity, "sourceHistoryHash" | "passStartMessageIndex" | "passEndMessageIndex" | "rangeHash">> {
	const firstTurn = state.turns[passStartTurnIndex]
	const lastTurn = state.turns[passEndTurnIndex]
	if (!firstTurn || !lastTurn || passEndTurnIndex < passStartTurnIndex) {
		throw new Error("Compaction Pass has an invalid logical-turn range")
	}
	const passStartMessageIndex = firstTurn.startMessageIndex
	const passEndMessageIndex = lastTurn.endMessageIndex
	const sourceHistoryHash = state.sourceHistoryHash
	const rangeValue = {
		sourceHistoryHash,
		passStartTurnIndex,
		passEndTurnIndex,
		passStartMessageIndex,
		passEndMessageIndex,
		messages: state.sourceSnapshot.messages.slice(passStartMessageIndex, passEndMessageIndex + 1),
	}
	return {
		sourceHistoryHash,
		passStartMessageIndex,
		passEndMessageIndex,
		rangeHash: hashJsonValue(rangeValue),
	}
}

/** Return the immutable canonical baseline restored after each hidden Pass. */
export function buildFittingSourceHistory(state: TargetWindowFittingState): ClineStorageMessage[] {
	return materializeCompactionSourceSuffix(state.sourceSnapshot, 0)
}

/** Build the staged ordinary target history without inspecting or rewriting message content. */
export function buildTargetCandidateHistory(
	state: TargetWindowFittingState,
	continuation: readonly ClineStorageMessage[],
): ClineStorageMessage[] {
	const uncoveredStartMessageIndex = state.turns[state.coveredTurnCount]?.startMessageIndex ?? state.protectedStartMessageIndex
	return [
		...(state.cumulativeSummary ? [compactionSummaryMessage(state.cumulativeSummary)] : []),
		...materializeCompactionSourceSuffix(state.sourceSnapshot, uncoveredStartMessageIndex),
		...cloneDeep(continuation),
	]
}

function hashSummaryBaseline(summary: string): string {
	return hashCompactionSummary(summary)
}

function hashJsonValue(value: unknown): string {
	return hashCompactionValue(value)
}
