import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { createCompactionSourceSnapshot, materializeCompactionSourceRange } from "../compaction-source-snapshot"
import { compactionSummaryMessage } from "../compaction-summary-message"
import { indexLogicalTurns } from "../logical-turns"
import {
	acceptCompactionPass,
	applyCompactionPassPlan,
	buildCompactionPassHistory,
	buildTargetCandidateHistory,
	isIterativeCompactionPass,
	refitCompactionSummary,
	startTargetWindowFitting,
	type TargetWindowFittingState,
	tryStartTargetWindowFitting,
} from "../target-window-fitting"

function message(role: "user" | "assistant", text: string): ClineStorageMessage {
	return { role, content: [{ type: "text", text }] }
}

function qnaAssistant(functionId: string, marker: string): ClineStorageMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: marker },
			{
				type: "tool_use",
				function_id: functionId,
				dline_tid: `tid-${functionId}`,
				name: "qna_respond",
				input: { response: marker },
			},
		],
	}
}

function qnaFeedback(functionId: string, text: string, additionalText?: string): ClineStorageMessage {
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				function_id: functionId,
				dline_tid: `tid-${functionId}`,
				content: `[qna_respond] Result:\n<feedback>${text}</feedback>`,
			},
			...(additionalText ? [{ type: "text" as const, text: additionalText }] : []),
		],
	}
}

function serialized(messages: readonly ClineStorageMessage[]): string {
	return JSON.stringify(messages)
}

function startFitting(history: readonly ClineStorageMessage[], operationId: string): TargetWindowFittingState {
	const snapshot = createCompactionSourceSnapshot(history)
	return startTargetWindowFitting(indexLogicalTurns(snapshot.messages), operationId, snapshot)
}

function tryStartFitting(history: readonly ClineStorageMessage[], operationId: string): TargetWindowFittingState | undefined {
	const snapshot = createCompactionSourceSnapshot(history)
	return tryStartTargetWindowFitting(indexLogicalTurns(snapshot.messages), operationId, snapshot)
}

function createHistory(): ClineStorageMessage[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: "<task>E2E_ROLLING_TASK</task>" },
				{ type: "text", text: "<environment_details>stale turn A environment</environment_details>" },
			],
		},
		qnaAssistant("call-a", "E2E_ROLLING_TURN_A"),
		qnaFeedback("call-a", "E2E_ROLLING_USER_TURN_B", "<environment_details>stale turn B environment</environment_details>"),
		qnaAssistant("call-b", "E2E_ROLLING_TURN_B"),
		qnaFeedback("call-b", "E2E_ROLLING_USER_TURN_C"),
	]
}

function planThrough(
	state: TargetWindowFittingState,
	passEndTurnIndex: number,
	nextPassSummaryCarryLimitTokens?: number,
): TargetWindowFittingState {
	return applyCompactionPassPlan(state, {
		operationId: state.operationId,
		passIndex: state.passIndex,
		passStartTurnIndex: state.coveredTurnCount,
		passEndTurnIndex,
		coveredTurnCount: state.coveredTurnCount,
		summaryBaselineHash: state.summaryBaselineHash,
		estimatedInputTokens: 100 + (passEndTurnIndex - state.coveredTurnCount + 1) * 100,
		passInputCeiling: 1_000,
		passHistoryHash: `sha256:pass-${state.passIndex}-${state.coveredTurnCount}-${passEndTurnIndex}`,
		...(nextPassSummaryCarryLimitTokens === undefined ? {} : { nextPassSummaryCarryLimitTokens }),
	})
}

/** Every Pass history must be provider-projectable: no tool use may lack its result. */
function expectPairedPassHistory(passHistory: readonly ClineStorageMessage[]): void {
	const openFunctionIds = new Set<string>()
	for (const message of passHistory) {
		if (!Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block.type === "tool_use") openFunctionIds.add(block.function_id)
			if (block.type === "tool_result") openFunctionIds.delete(block.function_id)
		}
	}
	expect([...openFunctionIds], JSON.stringify(passHistory)).toEqual([])
}

describe("target window rolling fitting", () => {
	it("requires an explicit Pass plan and preserves the exact selected turn prefix", () => {
		const unplanned = startFitting(createHistory(), "operation-rolling")
		expect(() => buildCompactionPassHistory(unplanned)).toThrow("Compaction Pass must be planned before building its history")

		const state = planThrough(unplanned, 1)
		const passHistory = buildCompactionPassHistory(state)
		const pass = serialized(passHistory)
		const selectedTurnPrefix = materializeCompactionSourceRange(
			state.sourceSnapshot,
			state.turns[state.passStartTurnIndex].startMessageIndex,
			state.turns[state.passEndTurnIndex].endMessageIndex,
		)

		expect(state).toMatchObject({
			operationId: "operation-rolling",
			passIndex: 0,
			passStartTurnIndex: 0,
			passEndTurnIndex: 1,
			coveredTurnCount: 0,
			passPlanned: true,
		})
		expect(state.summaryBaselineHash).toMatch(/^sha256:/)
		// The selected turn prefix is preserved verbatim. A trailing neutral pairing
		// message may follow it when the range ends on an unclosed conversational call.
		expect(passHistory.slice(0, selectedTurnPrefix.length)).toEqual(selectedTurnPrefix)
		expectPairedPassHistory(passHistory)
		expect(pass).toContain("E2E_ROLLING_TURN_A")
		expect(pass).toContain("E2E_ROLLING_TURN_B")
	})

	it("rolls the previous cumulative summary into the next planned uncovered range", () => {
		const initial = startFitting(createHistory(), "operation-rolling")
		const firstPass = planThrough(initial, 0)
		const afterFirst = acceptCompactionPass(firstPass, "E2E_ROLLING_SUMMARY_ONE").state
		const secondPlanned = planThrough(afterFirst, 1)
		const secondPassHistory = buildCompactionPassHistory(secondPlanned)
		const secondPass = serialized(secondPassHistory)
		const selectedTurnMessages = materializeCompactionSourceRange(
			secondPlanned.sourceSnapshot,
			secondPlanned.turns[secondPlanned.passStartTurnIndex].startMessageIndex,
			secondPlanned.turns[secondPlanned.passEndTurnIndex].endMessageIndex,
		)

		expect(afterFirst).toMatchObject({
			operationId: "operation-rolling",
			passIndex: 1,
			coveredTurnCount: 1,
			passPlanned: false,
		})
		expect(secondPlanned).toMatchObject({ passStartTurnIndex: 1, passEndTurnIndex: 1, passPlanned: true })
		expect(afterFirst.summaryBaselineHash).not.toBe(initial.summaryBaselineHash)
		expect(secondPassHistory.slice(1, 1 + selectedTurnMessages.length)).toEqual(selectedTurnMessages)
		expectPairedPassHistory(secondPassHistory)
		expect(secondPass).toContain("E2E_ROLLING_SUMMARY_ONE")
		expect(secondPass).toContain("E2E_ROLLING_TURN_B")
		expect(secondPass).not.toContain("E2E_ROLLING_TURN_A")
	})

	it("carries the planned next-Pass summary limit into the accepted unplanned state", () => {
		const initial = startFitting(createHistory(), "operation-carry-limit")
		const afterFirst = acceptCompactionPass(planThrough(initial, 0, 750), "SUMMARY_WITH_LIMIT").state

		expect(afterFirst).toMatchObject({
			passIndex: 1,
			coveredTurnCount: 1,
			passPlanned: false,
			nextPassSummaryCarryLimitTokens: 750,
		})
	})

	it("refits only the cumulative summary without advancing source coverage", () => {
		const initial = startFitting(createHistory(), "operation-summary-refit")
		const afterFirst = acceptCompactionPass(planThrough(initial, 0, 750), "SUMMARY_BEFORE_REFIT").state
		const refitted = refitCompactionSummary(afterFirst, "SUMMARY_AFTER_REFIT")

		expect(refitted).toMatchObject({
			operationId: "operation-summary-refit",
			passIndex: 1,
			coveredTurnCount: 1,
			passStartTurnIndex: 1,
			passEndTurnIndex: 0,
			cumulativeSummary: "SUMMARY_AFTER_REFIT",
			nextPassSummaryCarryLimitTokens: 750,
			passPlanned: false,
		})
		expect(refitted.summaryBaselineHash).not.toBe(afterFirst.summaryBaselineHash)
		expect(refitted.sourceSnapshot).toBe(afterFirst.sourceSnapshot)
		expect(refitted.turns).toBe(afterFirst.turns)
	})

	it("treats a later Pass or a first Pass that leaves turns uncovered as iterative", () => {
		const initial = startFitting(createHistory(), "operation-iterative")
		const lastTurnIndex = initial.turns.length - 1
		expect(lastTurnIndex).toBeGreaterThan(0)

		expect(isIterativeCompactionPass(planThrough(initial, lastTurnIndex))).toBe(false)
		const partialFirstPass = planThrough(initial, 0)
		expect(isIterativeCompactionPass(partialFirstPass)).toBe(true)
		const afterFirst = acceptCompactionPass(partialFirstPass, "E2E_ITERATIVE_SUMMARY").state
		expect(isIterativeCompactionPass(planThrough(afterFirst, lastTurnIndex))).toBe(true)
	})

	it("builds the ordinary target candidate by concatenating complete message ranges without rewriting content", () => {
		const initial = startFitting(createHistory(), "operation-target")
		const afterFirst = acceptCompactionPass(planThrough(initial, 0), "E2E_ROLLING_SUMMARY_ONE").state
		const continuation = [
			qnaAssistant("call-protected", "E2E_ROLLING_PROTECTED_TURN_C"),
			message(
				"user",
				"<user_message>E2E_ROLLING_CONTINUATION</user_message>\n<environment_details>dynamic only</environment_details>",
			),
		]
		const targetHistory = buildTargetCandidateHistory(afterFirst, continuation)
		const expectedMessages = [
			...afterFirst.sourceSnapshot.messages.slice(
				afterFirst.turns[afterFirst.coveredTurnCount]?.startMessageIndex ?? afterFirst.protectedStartMessageIndex,
			),
			...continuation,
		]

		expect(targetHistory[0]).toEqual(compactionSummaryMessage("E2E_ROLLING_SUMMARY_ONE"))
		expect(targetHistory.slice(1)).toEqual(expectedMessages)
	})

	it("keeps one-shot compaction when no complete logical turn is available", () => {
		const history = [message("user", "<user_message>pending</user_message>")]
		const snapshot = createCompactionSourceSnapshot(history)
		const index = indexLogicalTurns(snapshot.messages)

		expect(tryStartTargetWindowFitting(index, "operation-one-shot", snapshot)).toBeUndefined()
		expect(() => startTargetWindowFitting(index, "operation-one-shot", snapshot)).toThrow(
			"No complete logical turn is available for compaction",
		)
	})

	it("starts rolling fitting when at least one complete logical turn is available", () => {
		const state = tryStartFitting(createHistory(), "operation-rolling")

		expect(state).toMatchObject({ operationId: "operation-rolling", coveredTurnCount: 0, passIndex: 0 })
	})

	it("rejects an empty summary without advancing coverage", () => {
		const state = planThrough(startFitting(createHistory(), "operation-empty-summary"), 0)

		expect(() => acceptCompactionPass(state, "  ")).toThrow("Compaction summary must be non-empty")
		expect(state.coveredTurnCount).toBe(0)
	})
})
