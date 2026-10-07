import type { ApiHandler } from "@core/api"
import { CompactionPassBudgetError } from "@core/context/context-management/compaction-pass-budget-error"
import type { TargetWindowFittingDecision } from "@core/context/context-management/TargetWindowFittingService"
import type { CompactionProviderInput } from "@core/task/compaction/CompactionProviderInput"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import type { ClineStorageMessage } from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { ContextCompactionSession, type ContextCompactionSessionPorts } from "../ContextCompactionSession"

/**
 * The planner and the send-side budget can disagree about the size of the same request.
 *
 * Whatever causes the disagreement, the session must still converge: the planner has to be asked
 * again with a tighter ceiling until a range the send side accepts is found. Without that feedback
 * the planner keeps proposing the range the send side just rejected, so compaction can never make
 * progress and the task is stuck for good.
 */

const PASS_INPUT_CEILING = 10_000
/** Every message the planner proposes costs this much on the send side. */
const SEND_TOKENS_PER_MESSAGE = 3_000

function decision(status: TargetWindowFittingDecision["status"]): TargetWindowFittingDecision {
	return {
		status,
		projectedUsageTokens: 100,
		targetContextWindow: 1_000,
		effectiveContextLimit: 1_000,
		fittingExitTarget: 800,
	}
}

/** Four complete turns, so the planner has room to select a smaller range. */
function sourceHistory(): ClineStorageMessage[] {
	return [
		{ role: "user", content: [{ type: "text", text: "turn one" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer one" }] },
		{ role: "user", content: [{ type: "text", text: "turn two" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer two" }] },
		{ role: "user", content: [{ type: "text", text: "turn three" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer three" }] },
		{ role: "user", content: [{ type: "text", text: "turn four" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer four" }] },
	]
}

function summarizingApi(): ApiHandler {
	return {
		createMessage: vi.fn(async function* () {
			yield { type: "text", text: "<summarize_task>\n<context>\nsummary\n</context>\n</summarize_task>" }
			yield { type: "usage", inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0 }
		}),
	} as unknown as ApiHandler
}

interface DivergentPortsResult {
	ports: ContextCompactionSessionPorts
	rejectedPassSizes: number[]
	acceptedPassSizes: number[]
}

/**
 * Model a send side that measures each request higher than the planner does.
 *
 * The planner charges 10 tokens per message; the send side charges 3000. Any range the planner
 * accepts at the full ceiling is therefore rejected until the range shrinks.
 */
function createDivergentPorts(): DivergentPortsResult {
	const rejectedPassSizes: number[] = []
	const acceptedPassSizes: number[] = []

	const ports: ContextCompactionSessionPorts = {
		getPassInputCeiling: () => PASS_INPUT_CEILING,
		estimatePassInput: async (_input, history) => history.length * 10,
		buildPassRequest: vi.fn(async (_input, state, _feedback, passHistory) => {
			const messageCount = passHistory?.length ?? 0
			const sendEstimatedInputTokens = messageCount * SEND_TOKENS_PER_MESSAGE
			if (sendEstimatedInputTokens > PASS_INPUT_CEILING) {
				rejectedPassSizes.push(messageCount)
				throw new CompactionPassBudgetError({
					estimatedInputTokens: sendEstimatedInputTokens,
					contextWindow: PASS_INPUT_CEILING,
					availableRemainder: 0,
				})
			}
			acceptedPassSizes.push(messageCount)
			const explicitInstructions = new ExplicitInstructionRequestScope(new ExplicitInstructionRegistry(), {
				requestId: `request-${state.passIndex}`,
				attemptId: `attempt-${state.passIndex}`,
			})
			explicitInstructions.register({
				type: "summarize_task",
				source: "auto_compaction",
				targetTool: ClineDefaultTool.SUMMARIZE_TASK,
				operationId: state.operationId,
			})
			return {
				providerInput: {} as CompactionProviderInput,
				explicitInstructions,
				initialAttemptId: `attempt-${state.passIndex}`,
			}
		}),
		buildSummaryRefitRequest: vi.fn(async () => {
			throw new Error("summary refit is not expected in this scenario")
		}),
		reprojectTarget: vi.fn(async () => decision("complete")),
		stageAcceptedPass: vi.fn(async () => undefined),
		commit: vi.fn(async () => undefined),
		publish: vi.fn(async () => undefined),
		waitForRetry: vi.fn(async () => undefined),
		recordTiming: vi.fn(),
	}

	return { ports, rejectedPassSizes, acceptedPassSizes }
}

describe("ContextCompactionSession budget convergence", () => {
	it("replans with a tighter ceiling when the send side rejects the planned range", async () => {
		const { ports, rejectedPassSizes, acceptedPassSizes } = createDivergentPorts()
		const session = new ContextCompactionSession(ports, { maxRetryAttempts: 1 })

		const result = await session.run({
			operationId: "operation-budget-convergence",
			trigger: "auto_compaction",
			compactionApi: summarizingApi(),
			targetApi: summarizingApi(),
			targetMode: "act",
			sourceHistory: sourceHistory(),
		})

		expect(rejectedPassSizes.length).toBeGreaterThan(0)
		expect(acceptedPassSizes.length).toBeGreaterThan(0)
		// Each retry must ask for strictly less than the range that was just rejected.
		expect(Math.min(...acceptedPassSizes)).toBeLessThan(Math.max(...rejectedPassSizes))
		expect(result).toBe("completed")
	})

	it("stops with a diagnosable failure instead of looping when no range can fit", async () => {
		const { ports } = createDivergentPorts()
		ports.buildPassRequest = vi.fn(async () => {
			throw new CompactionPassBudgetError({
				estimatedInputTokens: 999_999,
				contextWindow: PASS_INPUT_CEILING,
				availableRemainder: 0,
			})
		})
		const session = new ContextCompactionSession(ports, { maxRetryAttempts: 1 })

		const result = await session.run({
			operationId: "operation-budget-unfittable",
			trigger: "auto_compaction",
			compactionApi: summarizingApi(),
			targetApi: summarizingApi(),
			targetMode: "act",
			sourceHistory: sourceHistory(),
		})

		expect(result).toBe("failed")
		// Bounded: the session must stop instead of retrying the same rejected range forever.
		expect((ports.buildPassRequest as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(8)
		// Narrowing down to a single turn that is still refused reports the measurement that
		// refused it, so the obstacle is diagnosable instead of surfacing as a silent stall.
		const failure = (ports.publish as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as {
			kind: string
			error: string
		}
		expect(failure.kind).toBe("failed")
		expect(failure.error).toContain("the hidden Pass request itself does not fit")
	})
})
