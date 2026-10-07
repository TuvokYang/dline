import type { ApiHandler } from "@core/api"
import { OutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import type { ApiStream } from "@core/api/transform/stream"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { CompactionAttemptDiagnostics } from "../compaction-attempt-diagnostics"
import { isCorrectableCompactionFailure, renderCompactionRetryReminder } from "../compaction-attempt-failure"
import { CompactionRetryPolicy } from "../compaction-retry-policy"
import { runInternalCompactionPassWithRetry } from "../internal-compaction-pass"

const passIdentity = {
	operationId: "operation-hidden-pass",
	passIndex: 2,
	passStartTurnIndex: 2,
	passEndTurnIndex: 3,
	coveredTurnCount: 2,
	summaryBaselineHash: "sha256:summary-baseline",
}

const providerInput = {
	systemPrompt: "system",
	messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "history" }] }],
	tools: [],
	serverTools: [],
	providerOutputCap: 1_000,
}

function createInstructions(): ExplicitInstructionRequestScope {
	const registry = new ExplicitInstructionRegistry()
	const instructions = new ExplicitInstructionRequestScope(registry, {
		requestId: "request-hidden-pass",
		attemptId: "attempt-0",
	})
	instructions.register({
		type: "summarize_task",
		source: "auto_compaction",
		targetTool: ClineDefaultTool.SUMMARIZE_TASK,
		operationId: passIdentity.operationId,
	})
	return instructions
}

function successfulStream(summary: string): ApiStream {
	return (async function* () {
		yield { type: "text" as const, text: summaryBlock(summary) }
		yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
	})()
}

function summaryBlock(summary: string): string {
	return `<summarize_task>\n<context>\n${summary}\n</context>\n</summarize_task>`
}

function failingStream(error: Error): ApiStream {
	return (async function* () {
		if (error) throw error
		yield { type: "text" as const, text: "" }
	})()
}

/** A Pass whose block ends after `</context>`, the reply shape that stalled task 1791122313218. */
function unclosedBlockStream(summary: string): ApiStream {
	return (async function* () {
		yield { type: "text" as const, text: `<summarize_task>\n<context>\n${summary}\n</context>\n` }
		yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
	})()
}

const REMINDER_HEADING = renderCompactionRetryReminder("missing_block").split("\n")[0]

type InstructionMessages = Array<{ role: string; content: Array<{ type: string; text: string }> }>

function reminderTexts(messages: unknown): string[] {
	const instruction = (messages as InstructionMessages).at(-1)
	return (instruction?.content ?? []).flatMap((block) => (block.text?.startsWith(REMINDER_HEADING) ? [block.text] : []))
}

/** A Pass that answers with plain text and another tool instead of summarize_task. */
function wrongToolStream(residue: string): ApiStream {
	return (async function* () {
		yield { type: "text" as const, text: residue }
		yield {
			type: "tool_calls" as const,
			function_id: "call-other-tool",
			phase: "completed" as const,
			tool_index: 0,
			tool_call: { function: { name: "read_file", arguments: JSON.stringify({ path: residue }) } },
		}
		yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
	})()
}

function streamingXmlSummaryStream(): ApiStream {
	return (async function* () {
		yield { type: "text" as const, text: "<summarize_task><context>First" }
		yield { type: "text" as const, text: " partial</context></summarize_task>" }
		yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
	})()
}

function cloneDeepJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

describe("internal compaction Pass retry owner", () => {
	it("continues reading Provider chunks while presentation is slow", async () => {
		let providerReadCount = 0
		let releaseFirstCallback: (() => void) | undefined
		let resolveFirstCallbackStarted: (() => void) | undefined
		const firstCallbackStarted = new Promise<void>((resolve) => {
			resolveFirstCallbackStarted = resolve
		})
		const firstCallbackRelease = new Promise<void>((resolve) => {
			releaseFirstCallback = resolve
		})
		const api = {
			createMessage: () =>
				(async function* () {
					providerReadCount += 1
					yield { type: "text" as const, text: summaryBlock("summary") }
					providerReadCount += 1
					yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
				})(),
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		let callbackCount = 0
		const runPromise = runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(0),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
			onChunk: async () => {
				callbackCount += 1
				if (callbackCount === 1) {
					resolveFirstCallbackStarted?.()
					await firstCallbackRelease
				}
			},
		})

		await firstCallbackStarted
		await vi.waitFor(() => expect(providerReadCount).toBe(2), { timeout: 100 })
		releaseFirstCallback?.()
		await runPromise
	})

	it("streams XML summary snapshots with the current attempt identity", async () => {
		const api = {
			createMessage: () => streamingXmlSummaryStream(),
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const updates: Array<{ content: string; attemptIndex: number; attemptId: string }> = []

		await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(0),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
			onSummaryUpdate: (content, attempt) => {
				updates.push({ content, attemptIndex: attempt.attemptIndex, attemptId: attempt.authorizationAttemptId })
			},
		})

		expect(updates).toEqual([
			{ content: "First", attemptIndex: 0, attemptId: "attempt-0" },
			{ content: "First partial", attemptIndex: 0, attemptId: "attempt-0" },
		])
	})

	it("retries one immutable Pass with a fresh attempt identity and frozen Provider input", async () => {
		const calls: Array<{ messages: unknown; maxOutputTokens?: number }> = []
		let requestCount = 0
		const api = {
			createMessage: (_systemPrompt, messages, _tools, options) => {
				calls.push({ messages, maxOutputTokens: options?.generation?.maxOutputTokens })
				requestCount++
				return requestCount === 1 ? failingStream(new Error("network failure")) : successfulStream("Recovered summary")
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const onRetry = vi.fn()

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(3),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
			onRetry,
		})

		expect(result).toMatchObject({
			summary: "Recovered summary",
			attemptIndex: 1,
			authorizationAttemptId: "attempt-1",
		})
		expect(calls).toEqual([
			{ messages: providerInput.messages, maxOutputTokens: 1_000 },
			{ messages: providerInput.messages, maxOutputTokens: 1_000 },
		])
		expect(onRetry).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "pass_retry",
				retryAttempt: 1,
				maxRetryAttempts: 3,
				failedAttempt: { attemptIndex: 0, authorizationAttemptId: "attempt-0" },
				nextAttempt: { attemptIndex: 1, authorizationAttemptId: "attempt-1" },
			}),
		)
	})

	it("accepts a completed summary when the Provider stream fails during tail settlement", async () => {
		const tailError = new Error("connection closed after the completed summary")
		const createMessage = vi.fn(() =>
			(async function* (): ApiStream {
				yield {
					type: "text" as const,
					text: summaryBlock(
						"The completed summary preserves the confirmed architecture, the current implementation boundary, and the exact next verification step.",
					),
				}
				throw tailError
			})(),
		)
		const api = {
			createMessage,
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const onRetry = vi.fn()
		const waitForRetry = vi.fn(async () => undefined)

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(3),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry,
			onRetry,
		})

		expect(result).toMatchObject({
			summary:
				"The completed summary preserves the confirmed architecture, the current implementation boundary, and the exact next verification step.",
			attemptIndex: 0,
			authorizationAttemptId: "attempt-0",
		})
		expect(createMessage).toHaveBeenCalledOnce()
		expect(onRetry).not.toHaveBeenCalled()
		expect(waitForRetry).not.toHaveBeenCalled()
	})

	it("does not replay an immutable Pass after a deterministic HTTP 400", async () => {
		const error = Object.assign(new Error("400 No tool output found for function call fc_compaction."), { status: 400 })
		const createMessage = vi.fn(() => failingStream(error))
		const api = {
			createMessage,
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const waitForRetry = vi.fn(async () => undefined)

		await expect(
			runInternalCompactionPassWithRetry({
				api,
				providerInput,
				explicitInstructions: createInstructions(),
				passIdentity,
				retryPolicy: new CompactionRetryPolicy(3),
				attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
				waitForRetry,
			}),
		).rejects.toThrow("No tool output found")
		expect(createMessage).toHaveBeenCalledOnce()
		expect(waitForRetry).not.toHaveBeenCalled()
	})

	it("retains Pass retry for transient HTTP 503 failures", async () => {
		let requestCount = 0
		const api = {
			createMessage: () => {
				requestCount++
				return requestCount === 1
					? failingStream(Object.assign(new Error("Service unavailable"), { status: 503 }))
					: successfulStream("Recovered summary")
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const waitForRetry = vi.fn(async () => undefined)

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(3),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry,
		})

		expect(result).toMatchObject({ summary: "Recovered summary", attemptIndex: 1 })
		expect(waitForRetry).toHaveBeenCalledOnce()
	})

	it("fails after the Pass retry policy is exhausted without invoking another retry owner", async () => {
		const api = {
			createMessage: () => failingStream(new Error("network failure")),
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const waitForRetry = vi.fn(async () => undefined)

		await expect(
			runInternalCompactionPassWithRetry({
				api,
				providerInput,
				explicitInstructions: createInstructions(),
				passIdentity,
				retryPolicy: new CompactionRetryPolicy(1),
				attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
				waitForRetry,
			}),
		).rejects.toThrow("network failure")
		expect(waitForRetry).toHaveBeenCalledOnce()
	})

	it("retries an unusable reply from the frozen input with one reminder inside the instruction message", async () => {
		const calls: unknown[] = []
		const api = {
			createMessage: (_systemPrompt, messages) => {
				calls.push(cloneDeepJson(messages))
				return calls.length < 3
					? wrongToolStream(`RESIDUE_ATTEMPT_${calls.length}`)
					: successfulStream("Corrected summary")
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const frozenInput = cloneDeepJson(providerInput)

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(2),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
		})

		expect(result).toMatchObject({ summary: "Corrected summary", attemptIndex: 2 })
		expect(calls).toHaveLength(3)
		expect(calls[0]).toEqual(providerInput.messages)
		for (const retryMessages of calls.slice(1)) {
			const messages = retryMessages as InstructionMessages
			expect(messages).toHaveLength(providerInput.messages.length)
			const instructionMessage = messages.at(-1)
			expect(instructionMessage?.content.slice(0, -1)).toEqual(providerInput.messages.at(-1)?.content)
			expect(reminderTexts(messages)).toEqual([renderCompactionRetryReminder("foreign_tool_call")])
			expect(JSON.stringify(messages)).not.toContain("RESIDUE_ATTEMPT_")
		}
		expect(providerInput).toEqual(frozenInput)
	})

	it("replaces the previous reminder and reports each attempt's next action", async () => {
		const calls: unknown[] = []
		const api = {
			createMessage: (_systemPrompt, messages) => {
				calls.push(cloneDeepJson(messages))
				if (calls.length === 1) return wrongToolStream("RESIDUE_ATTEMPT_1")
				return calls.length === 2 ? unclosedBlockStream("Almost done") : successfulStream("Closed summary")
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const settled: CompactionAttemptDiagnostics[] = []

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(2),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
			onAttemptSettled: (diagnostics) => settled.push(diagnostics),
		})

		expect(result).toMatchObject({ summary: "Closed summary", attemptIndex: 2 })
		expect(reminderTexts(calls[0])).toEqual([])
		expect(reminderTexts(calls[1])).toEqual([renderCompactionRetryReminder("foreign_tool_call")])
		expect(reminderTexts(calls[2])).toEqual([renderCompactionRetryReminder("unclosed_block")])
		expect(
			settled.map(({ attemptIndex, outcome, failureKind, reminderKind, nextAction }) => ({
				attemptIndex,
				outcome,
				failureKind,
				reminderKind,
				nextAction,
			})),
		).toEqual([
			{
				attemptIndex: 0,
				outcome: "failed",
				failureKind: "foreign_tool_call",
				reminderKind: undefined,
				nextAction: "retry",
			},
			{
				attemptIndex: 1,
				outcome: "failed",
				failureKind: "unclosed_block",
				reminderKind: "foreign_tool_call",
				nextAction: "retry",
			},
			{
				attemptIndex: 2,
				outcome: "accepted",
				failureKind: undefined,
				reminderKind: "unclosed_block",
				nextAction: "accept",
			},
		])
	})

	it("reports fail as the next action once the retry budget is exhausted", async () => {
		const settled: CompactionAttemptDiagnostics[] = []
		const api = {
			createMessage: () => unclosedBlockStream("Never closed"),
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler

		await expect(
			runInternalCompactionPassWithRetry({
				api,
				providerInput,
				explicitInstructions: createInstructions(),
				passIdentity,
				retryPolicy: new CompactionRetryPolicy(1),
				attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
				waitForRetry: async () => undefined,
				onAttemptSettled: (diagnostics) => settled.push(diagnostics),
			}),
		).rejects.toMatchObject({ failureKind: "unclosed_block" })
		expect(settled.map((diagnostics) => diagnostics.nextAction)).toEqual(["retry", "fail"])
	})

	it("limits retries to correctable failures when the caller scopes the retry policy", async () => {
		let requestCount = 0
		const api = {
			createMessage: () => {
				requestCount++
				return failingStream(Object.assign(new Error("503 overloaded"), { status: 503 }))
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler

		await expect(
			runInternalCompactionPassWithRetry({
				api,
				providerInput,
				explicitInstructions: createInstructions(),
				passIdentity,
				retryPolicy: new CompactionRetryPolicy(2),
				retryableFailure: isCorrectableCompactionFailure,
				attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
				waitForRetry: async () => undefined,
			}),
		).rejects.toThrow("503 overloaded")
		expect(requestCount).toBe(1)
	})

	it("owns the one OpenAI max-output replay and reduces only the frozen output cap", async () => {
		const caps: Array<number | undefined> = []
		const calls: unknown[] = []
		let requestCount = 0
		const api = {
			createMessage: (_systemPrompt, messages, _tools, options) => {
				caps.push(options?.generation?.maxOutputTokens)
				calls.push(cloneDeepJson(messages))
				requestCount++
				return requestCount === 1
					? failingStream(new OutputLimitExceededError("openai_responses", "max_output_tokens"))
					: successfulStream("Reduced-cap summary")
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const onRetry = vi.fn()

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(0),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
			onRetry,
		})

		expect(result).toMatchObject({ summary: "Reduced-cap summary", attemptIndex: 1 })
		expect(caps).toEqual([1_000, 900])
		expect(reminderTexts(calls[0])).toEqual([])
		expect(reminderTexts(calls[1])).toEqual([renderCompactionRetryReminder("output_limit")])
		expect(onRetry).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "openai_max_output_replay",
				providerOutputCap: 900,
				failedAttempt: { attemptIndex: 0, authorizationAttemptId: "attempt-0" },
				nextAttempt: { attemptIndex: 1, authorizationAttemptId: "attempt-1" },
			}),
		)
	})

	it("keeps the reduced cap when a normal Pass retry follows the OpenAI replay", async () => {
		const caps: Array<number | undefined> = []
		let requestCount = 0
		const api = {
			createMessage: (_systemPrompt, _messages, _tools, options) => {
				caps.push(options?.generation?.maxOutputTokens)
				requestCount++
				if (requestCount === 1) {
					return failingStream(new OutputLimitExceededError("openai_responses", "max_output_tokens"))
				}
				return requestCount === 2
					? failingStream(new Error("network failure"))
					: successfulStream("Stable reduced summary")
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(1),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
		})

		expect(result).toMatchObject({ summary: "Stable reduced summary", attemptIndex: 2 })
		expect(caps).toEqual([1_000, 900, 900])
	})

	it("retries a repeated OpenAI max-output failure within the ordinary budget at the reduced cap", async () => {
		const caps: Array<number | undefined> = []
		const api = {
			createMessage: (_systemPrompt, _messages, _tools, options) => {
				caps.push(options?.generation?.maxOutputTokens)
				return failingStream(new OutputLimitExceededError("openai_chat", "length"))
			},
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler
		const waitForRetry = vi.fn(async () => undefined)

		await expect(
			runInternalCompactionPassWithRetry({
				api,
				providerInput,
				explicitInstructions: createInstructions(),
				passIdentity,
				retryPolicy: new CompactionRetryPolicy(1),
				attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
				waitForRetry,
			}),
		).rejects.toBeInstanceOf(OutputLimitExceededError)
		expect(caps).toEqual([1_000, 900, 900])
		expect(waitForRetry).toHaveBeenCalledOnce()
	})
})
