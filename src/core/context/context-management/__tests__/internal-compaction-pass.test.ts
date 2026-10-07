import type { ApiHandler } from "@core/api"
import type { ApiStream } from "@core/api/transform/stream"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { runInternalCompactionPass } from "../internal-compaction-pass"

function createApi(stream: ApiStream): ApiHandler {
	return {
		createMessage: () => stream,
		getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
	}
}

function summaryBlock(summary: string): string {
	return `<summarize_task>\n<context>\n${summary}\n</context>\n</summarize_task>`
}

describe("internal compaction Pass", () => {
	it("reads a block split across text chunks and resolves cumulative and delta usage", async () => {
		async function* stream(): ApiStream {
			yield { type: "text", text: "<summarize_task>\n<context>\nChat-family " }
			yield { type: "text", text: "cumulative summary\n</con" }
			yield { type: "text", text: "text>\n</summarize_" }
			yield { type: "text", text: "task>" }
			yield { type: "usage", inputTokens: 100, outputTokens: 0 }
			yield { type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 8 }
			yield { type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 12 }
			yield { type: "usage", inputTokens: 100, outputTokens: 20 }
		}

		const registry = new ExplicitInstructionRegistry()
		const instructions = new ExplicitInstructionRequestScope(registry, {
			requestId: "request-chat",
			attemptId: "attempt-0",
		})
		instructions.register({
			type: "summarize_task",
			source: "auto_compaction",
			targetTool: ClineDefaultTool.SUMMARIZE_TASK,
			operationId: "operation-chat",
		})

		const result = await runInternalCompactionPass({
			api: createApi(stream()),
			providerInput: {
				systemPrompt: "system",
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
				tools: [],
				serverTools: [],
				providerOutputCap: 1_000,
			},
			explicitInstructions: instructions,
		})

		expect(result.summary).toBe("Chat-family cumulative summary")
		expect(result.usage).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 120,
		})
		expect(instructions.getPendingToolAuthorization(ClineDefaultTool.SUMMARIZE_TASK)).toBeUndefined()
	})

	it("binds the Provider attempt and attaches exact usage only after the stream reaches terminal", async () => {
		const events: string[] = []
		async function* stream(): ApiStream {
			yield { type: "text", text: summaryBlock("Observed summary") }
			events.push("tail")
			yield { type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }
		}
		const registry = new ExplicitInstructionRegistry()
		const instructions = new ExplicitInstructionRequestScope(registry, {
			requestId: "request-observed",
			attemptId: "attempt-2",
		})
		instructions.register({
			type: "summarize_task",
			source: "auto_compaction",
			targetTool: ClineDefaultTool.SUMMARIZE_TASK,
			operationId: "operation-observed",
		})

		const result = await runInternalCompactionPass({
			api: createApi(stream()),
			providerInput: {
				systemPrompt: "system",
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
				tools: [],
				serverTools: [],
				providerOutputCap: 1_000,
			},
			explicitInstructions: instructions,
			taskAttempt: 2,
			providerRequestRound: {
				bindAttempt: (providerStream, taskAttempt) => {
					events.push(`bind:${taskAttempt}`)
					return providerStream
				},
				attachExactUsage: (usage) => events.push(`usage:${JSON.stringify(usage)}`),
				completeProviderOnly: () => undefined,
				completeTools: () => undefined,
				completeTurnEndAwaitingUser: () => undefined,
			},
		})

		expect(result.summary).toBe("Observed summary")
		expect(events).toEqual([
			"bind:2",
			"tail",
			'usage:{"inputTokens":100,"outputTokens":20,"cacheWriteTokens":0,"cacheReadTokens":0,"cacheUsageReported":true}',
		])
	})

	it("returns one authorized summary and reliable usage without UI or canonical-history ports", async () => {
		async function* stream(): ApiStream {
			yield { type: "text", text: summaryBlock("Cumulative summary") }
			yield { type: "usage", inputTokens: 100, outputTokens: 20 }
		}

		const registry = new ExplicitInstructionRegistry()
		const instructions = new ExplicitInstructionRequestScope(registry, {
			requestId: "request-1",
			attemptId: "attempt-0",
		})
		instructions.register({
			type: "summarize_task",
			source: "auto_compaction",
			targetTool: ClineDefaultTool.SUMMARIZE_TASK,
			operationId: "operation-1",
		})

		const result = await runInternalCompactionPass({
			api: createApi(stream()),
			providerInput: {
				systemPrompt: "system",
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
				tools: [],
				serverTools: [],
				providerOutputCap: 1_000,
			},
			explicitInstructions: instructions,
		})

		expect(result.summary).toBe("Cumulative summary")
		expect(result.usage).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 120,
		})
		expect(instructions.getPendingToolAuthorization(ClineDefaultTool.SUMMARIZE_TASK)).toBeUndefined()
	})

	it("coalesces summary updates so a slow presentation never replays stale snapshots after the stream ends", async () => {
		const words = Array.from({ length: 40 }, (_, index) => `word${index}`)
		let releaseFirstUpdate!: () => void
		const firstUpdateGate = new Promise<void>((resolve) => {
			releaseFirstUpdate = resolve
		})
		async function* stream(): ApiStream {
			yield { type: "text", text: "<summarize_task>\n<context>\n" }
			for (const word of words) yield { type: "text", text: `${word} ` }
			yield { type: "text", text: "\n</context>\n</summarize_task>" }
			releaseFirstUpdate()
		}
		const registry = new ExplicitInstructionRegistry()
		const instructions = new ExplicitInstructionRequestScope(registry, {
			requestId: "request-coalesce",
			attemptId: "attempt-0",
		})
		instructions.register({
			type: "summarize_task",
			source: "auto_compaction",
			targetTool: ClineDefaultTool.SUMMARIZE_TASK,
			operationId: "operation-coalesce",
		})
		const updates: string[] = []

		const result = await runInternalCompactionPass({
			api: createApi(stream()),
			providerInput: {
				systemPrompt: "system",
				messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
				tools: [],
				serverTools: [],
			},
			explicitInstructions: instructions,
			// The first delivery stays blocked until the Provider has finished, like a slow Webview.
			onSummaryUpdate: async (context) => {
				updates.push(context)
				if (updates.length === 1) await firstUpdateGate
			},
		})

		const fullSummary = words.join(" ")
		expect(result.summary).toBe(fullSummary)
		expect(updates.length).toBeLessThanOrEqual(2)
		expect(updates.at(-1)).toBe(fullSummary)
	})
})
