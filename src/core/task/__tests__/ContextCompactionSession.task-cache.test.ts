import type { ApiHandler, ApiRequestOptions } from "@core/api"
import type { TargetWindowFittingDecision } from "@core/context/context-management/TargetWindowFittingService"
import type { CompactionProviderInput } from "@core/task/compaction/CompactionProviderInput"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import type { ClineStorageMessage } from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { ContextCompactionSession, type ContextCompactionSessionPorts } from "../ContextCompactionSession"

const HISTORY: ClineStorageMessage[] = [
	{ role: "user", content: [{ type: "text", text: "turn one" }] },
	{ role: "assistant", content: [{ type: "text", text: "answer one" }] },
	{ role: "user", content: [{ type: "text", text: "turn two" }] },
	{ role: "assistant", content: [{ type: "text", text: "answer two" }] },
]

function completeProjection(): TargetWindowFittingDecision {
	return {
		status: "complete",
		projectedUsageTokens: 100,
		targetContextWindow: 1_000,
		effectiveContextLimit: 1_000,
		fittingExitTarget: 800,
	}
}

function createPorts(): ContextCompactionSessionPorts {
	return {
		getPassInputCeiling: () => 10_000,
		estimatePassInput: async (_input, history) => history.length * 10,
		buildPassRequest: async (_input, state) => {
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
				providerInput: {
					systemPrompt: "system",
					messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
					tools: [],
					serverTools: [],
				} satisfies CompactionProviderInput,
				explicitInstructions,
				initialAttemptId: `attempt-${state.passIndex}`,
			}
		},
		buildSummaryRefitRequest: async (_input, state, carryLimitTokens, refitAttempt) => {
			const explicitInstructions = new ExplicitInstructionRequestScope(new ExplicitInstructionRegistry(), {
				requestId: `refit-request-${state.passIndex}-${refitAttempt}`,
				attemptId: `refit-attempt-${state.passIndex}-${refitAttempt}`,
			})
			explicitInstructions.register({
				type: "summarize_task",
				source: "auto_compaction",
				targetTool: ClineDefaultTool.SUMMARIZE_TASK,
				operationId: state.operationId,
			})
			return {
				providerInput: {
					systemPrompt: "system",
					messages: [{ role: "user", content: [{ type: "text", text: state.cumulativeSummary ?? "" }] }],
					tools: [],
					serverTools: [],
					providerOutputCap: carryLimitTokens,
				} satisfies CompactionProviderInput,
				explicitInstructions,
				initialAttemptId: `refit-attempt-${state.passIndex}-${refitAttempt}`,
			}
		},
		reprojectTarget: async () => completeProjection(),
		stageAcceptedPass: async () => undefined,
		commit: async () => undefined,
		publish: async () => undefined,
		waitForRetry: async () => undefined,
	}
}

describe("ContextCompactionSession Task cache namespace", () => {
	it("passes the owning Task ID to the hidden compaction Provider request", async () => {
		let requestOptions: ApiRequestOptions | undefined
		const createMessage: ApiHandler["createMessage"] = (_systemPrompt, _messages, _tools, options) => {
			requestOptions = options
			return (async function* () {
				yield {
					type: "text" as const,
					text: "<summarize_task>\n<context>\nsummary\n</context>\n</summarize_task>",
				}
				yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 }
			})()
		}
		const api = {
			createMessage: vi.fn(createMessage),
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const session = new ContextCompactionSession(createPorts(), { maxRetryAttempts: 1 })

		const result = await session.run({
			operationId: "operation-task-cache",
			trigger: "auto_compaction",
			taskNamespace: "task-123",
			compactionApi: api,
			targetApi: api,
			targetMode: "act",
			sourceHistory: HISTORY,
		})

		expect(result).toBe("completed")
		expect(requestOptions?.taskNamespace).toBe("task-123")
	})
})
