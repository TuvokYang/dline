import type { ApiHandler } from "@core/api"
import { OutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import type { ApiStream } from "@core/api/transform/stream"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { CompactionRetryPolicy } from "../compaction-retry-policy"
import { isUnusableCompactionSummaryError, runInternalCompactionPassWithRetry } from "../internal-compaction-pass"

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
		yield {
			type: "tool_calls" as const,
			function_id: "call-summary",
			phase: "completed" as const,
			tool_index: 0,
			tool_call: {
				function: {
					name: ClineDefaultTool.SUMMARIZE_TASK,
					arguments: JSON.stringify({ context: summary }),
				},
			},
		}
		yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
	})()
}

function failingStream(error: Error): ApiStream {
	return (async function* () {
		if (error) throw error
		yield { type: "text" as const, text: "" }
	})()
}

function streamingSummaryStream(): ApiStream {
	return (async function* () {
		yield {
			type: "tool_calls" as const,
			function_id: "call-summary",
			phase: "delta" as const,
			tool_index: 0,
			tool_call: { function: { name: ClineDefaultTool.SUMMARIZE_TASK, arguments: '{"context":"First' } },
		}
		yield {
			type: "tool_calls" as const,
			function_id: "call-summary",
			phase: "completed" as const,
			tool_index: 0,
			tool_call: { function: { name: ClineDefaultTool.SUMMARIZE_TASK, arguments: ' partial"}' } },
		}
		yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
	})()
}

const CORRECTION_MARKER = "The previous compaction attempt did not return a usable summarize_task call"

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
					yield {
						type: "tool_calls" as const,
						function_id: "call-summary-backpressure",
						phase: "completed" as const,
						tool_index: 0,
						tool_call: {
							function: {
								name: ClineDefaultTool.SUMMARIZE_TASK,
								arguments: JSON.stringify({ context: "summary" }),
							},
						},
					}
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

	it("streams partial summary snapshots with the current attempt identity", async () => {
		const api = {
			createMessage: () => streamingSummaryStream(),
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
					type: "tool_calls" as const,
					function_id: "call-summary-tail-failure",
					phase: "completed" as const,
					tool_index: 0,
					tool_call: {
						function: {
							name: ClineDefaultTool.SUMMARIZE_TASK,
							arguments: JSON.stringify({
								context:
									"The completed summary preserves the confirmed architecture, the current implementation boundary, and the exact next verification step.",
							}),
						},
					},
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

	it("retries an unusable summary from the frozen input with the correction inside the instruction message", async () => {
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
			const messages = retryMessages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
			expect(messages).toHaveLength(providerInput.messages.length)
			const instructionMessage = messages.at(-1)
			expect(instructionMessage?.content.slice(0, -1)).toEqual(providerInput.messages.at(-1)?.content)
			expect(instructionMessage?.content.at(-1)?.text).toContain(CORRECTION_MARKER)
			expect(JSON.stringify(messages).split(CORRECTION_MARKER)).toHaveLength(2)
			expect(JSON.stringify(messages)).not.toContain("RESIDUE_ATTEMPT_")
		}
		expect(providerInput).toEqual(frozenInput)
	})

	it("limits retries to unusable summaries when the caller scopes the retry policy", async () => {
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
				retryableFailure: isUnusableCompactionSummaryError,
				attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
				waitForRetry: async () => undefined,
			}),
		).rejects.toThrow("503 overloaded")
		expect(requestCount).toBe(1)
	})

	it("owns the one OpenAI max-output replay and reduces only the frozen output cap", async () => {
		const caps: Array<number | undefined> = []
		let requestCount = 0
		const api = {
			createMessage: (_systemPrompt, _messages, _tools, options) => {
				caps.push(options?.generation?.maxOutputTokens)
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

	it("reports every streamed summary snapshot to the rendering owner", async () => {
		const updates: string[] = []
		const first = "First snapshot"
		const second = "Second snapshot"
		const api = {
			createMessage: () =>
				(async function* () {
					for (const context of [first, second]) {
						yield {
							type: "tool_calls" as const,
							function_id: "call-summary-updates",
							tool_index: 0,
							tool_call: {
								function: {
									name: ClineDefaultTool.SUMMARIZE_TASK,
									arguments: JSON.stringify({ context }),
								},
							},
						}
					}
					yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
				})(),
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler

		await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(0),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
			onSummaryUpdate: async (context) => {
				updates.push(context)
			},
		})

		expect(updates).toEqual([first, second])
	})

	it("resolves the summary when a Responses-family adapter emits the same complete arguments twice", async () => {
		const summary = "Responses duplicate snapshot summary"
		const completeArguments = JSON.stringify({ context: summary })
		const api = {
			createMessage: () =>
				(async function* () {
					// Responses adapters emit the complete arguments first as a delta
					// and again on output_item.done without a "completed" phase marker.
					yield {
						type: "tool_calls" as const,
						function_id: "call-responses-summary",
						tool_index: 0,
						tool_call: {
							function: { name: ClineDefaultTool.SUMMARIZE_TASK, arguments: completeArguments },
						},
					}
					yield {
						type: "tool_calls" as const,
						function_id: "call-responses-summary",
						tool_index: 0,
						tool_call: {
							function: { name: ClineDefaultTool.SUMMARIZE_TASK, arguments: completeArguments },
						},
					}
					yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 }
				})(),
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		} satisfies ApiHandler

		const result = await runInternalCompactionPassWithRetry({
			api,
			providerInput,
			explicitInstructions: createInstructions(),
			passIdentity,
			retryPolicy: new CompactionRetryPolicy(0),
			attemptIdFactory: (attemptIndex) => `attempt-${attemptIndex}`,
			waitForRetry: async () => undefined,
		})

		expect(result.summary).toBe(summary)
	})

	it("does not hand a repeated OpenAI max-output failure to the ordinary Pass retry budget", async () => {
		const api = {
			createMessage: () => failingStream(new OutputLimitExceededError("openai_chat", "length")),
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
		).rejects.toBeInstanceOf(OutputLimitExceededError)
		expect(waitForRetry).not.toHaveBeenCalled()
	})
})
