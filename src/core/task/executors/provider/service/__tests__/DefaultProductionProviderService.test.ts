import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it, vi } from "vitest"
import type { ProviderDraftEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk } from "../../ProductionProviderAdapter"
import { DefaultProductionProviderService, type ProviderRetryPolicy } from "../DefaultProductionProviderService"
import type { PreparedProviderRequest } from "../ProviderRequest"

/** A provider that streams the given chunks and nothing else. */
function streamingApi(chunks: readonly ApiStreamChunk[]): ApiHandler {
	return {
		createMessage: async function* () {
			for (const chunk of chunks) yield chunk
		},
		getModel: () => ({ id: "test-model", info: {} }),
	} as unknown as ApiHandler
}

function service(chunks: readonly ApiStreamChunk[], nativeTools: boolean) {
	const request = {
		api: streamingApi(chunks),
		systemPrompt: "",
		nativeTools,
		mode: "serial",
		profile: "standard",
		messages: [],
		turnId: "turn-1",
		planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
	} as unknown as PreparedProviderRequest
	let id = 0
	return new DefaultProductionProviderService({ requests: { prepare: async () => request }, nextPresentationId: () => ++id })
}

async function run(chunks: readonly ApiStreamChunk[], nativeTools: boolean): Promise<ProductionProviderChunk[]> {
	const out: ProductionProviderChunk[] = []
	const iterable = service(chunks, nativeTools).start({
		draftRef: "draft-1",
		draft: {} as ProviderDraftEnvelope,
		signal: new AbortController().signal,
	})
	for await (const chunk of iterable) out.push(chunk)
	return out
}

function text(value: string): ApiStreamChunk {
	return { type: "text", text: value } as ApiStreamChunk
}

const MARKUP = "<summarize_task><context>SECRET_SUMMARY</context></summarize_task>"

describe("DefaultProductionProviderService", () => {
	// WS-013: a call the model writes as markup, even when offered native tools,
	// is a call for the tool gate to decide, never prose shown to the user.
	it("never shows tool markup a native-tool reply wrote into its prose, while streaming or after", async () => {
		const chunks = await run(
			[text("Before. <summarize_task><context>SECRET"), text("_SUMMARY</context></summarize_task>")],
			true,
		)

		const shown = chunks.flatMap((chunk) => ("text" in chunk && typeof chunk.text === "string" ? [chunk.text] : []))
		expect(shown.length).toBeGreaterThan(0)
		for (const value of shown) expect(value).not.toContain("SECRET")
		const final = chunks.find((chunk) => chunk.kind === "final")
		expect(final).toMatchObject({ kind: "final", text: "Before." })
	})

	it("materializes that markup as a non-native call so the gate can refuse it", async () => {
		const chunks = await run([text(MARKUP)], true)

		const final = chunks.find((chunk) => chunk.kind === "final")
		expect(final?.kind === "final" ? final.blocks : []).toEqual([
			expect.objectContaining({
				invocation: expect.objectContaining({
					toolName: "summarize_task",
					isNativeToolCall: false,
					input: { context: "SECRET_SUMMARY" },
				}),
			}),
		])
	})

	it("keeps plain prose of a native-tool reply intact", async () => {
		const chunks = await run([text("Just an answer.")], true)

		const final = chunks.find((chunk) => chunk.kind === "final")
		expect(final).toMatchObject({ kind: "final", text: "Just an answer.", blocks: [] })
	})

	// A call written as markup beside native tools was never a provider call:
	// recording it as one replayed an invented call id on the next request.
	it("records markup beside native tools as the text the model sent, with a prose-only result", async () => {
		const chunks = await run([text(`Before. ${MARKUP}`)], true)

		const final = chunks.find((chunk) => chunk.kind === "final")
		if (final?.kind !== "final") throw new Error("missing final chunk")
		expect(final.content).toEqual([{ type: "text", text: `Before. ${MARKUP}` }])
		expect(final.blocks.map((block) => block.invocation.resultReplay)).toEqual(["text"])
	})

	it("records a native call as a paired tool call", async () => {
		const chunks = await run(
			[
				{
					type: "tool_calls",
					function_id: "call_native",
					dline_tid: "tid_native",
					argumentsMode: "snapshot",
					tool_call: { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
				} as ApiStreamChunk,
			],
			true,
		)

		const final = chunks.find((chunk) => chunk.kind === "final")
		if (final?.kind !== "final") throw new Error("missing final chunk")
		expect(final.content).toEqual([
			expect.objectContaining({ type: "tool_use", function_id: "call_native", name: "read_file" }),
		])
		expect(final.blocks.map((block) => block.invocation.resultReplay)).toEqual([undefined])
	})

	// A completed turn-ending call hands the next interaction to the user. dev
	// stopped reading the stream there; without it the provider kept streaming
	// reasoning the user already moved past, and the request stayed open.
	it("stops reading after a completed turn-ending call and aborts the transport", async () => {
		const abort = vi.fn()
		let pulledAfterTurnEnd = false
		const api = {
			createMessage: async function* () {
				yield {
					type: "tool_calls",
					function_id: "call_plan",
					dline_tid: "tid_plan",
					argumentsMode: "snapshot",
					tool_call: { function: { name: "make_plan", arguments: '{"response":"PLAN"}' } },
				} as ApiStreamChunk
				yield {
					type: "tool_calls",
					phase: "completed",
					function_id: "call_plan",
					dline_tid: "tid_plan",
					argumentsMode: "snapshot",
					tool_call: { function: { arguments: '{"response":"PLAN"}' } },
				} as ApiStreamChunk
				yield { type: "usage", inputTokens: 10, outputTokens: 5 } as ApiStreamChunk
				yield { type: "reasoning", reasoning: "AFTER_TURN_END" } as ApiStreamChunk
				pulledAfterTurnEnd = true
				yield text("AFTER_TURN_END_TEXT")
			},
			getModel: () => ({ id: "test-model", info: {} }),
			abort,
		} as unknown as ApiHandler
		const request = {
			api,
			systemPrompt: "",
			nativeTools: true,
			mode: "serial",
			profile: "standard",
			messages: [],
			turnId: "turn-1",
			planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: true, approval: { kind: "none" } }),
		} as unknown as PreparedProviderRequest
		const out: ProductionProviderChunk[] = []
		for await (const chunk of new DefaultProductionProviderService({ requests: { prepare: async () => request } }).start({
			draftRef: "draft-1",
			draft: {} as ProviderDraftEnvelope,
			signal: new AbortController().signal,
		}))
			out.push(chunk)

		expect(abort).toHaveBeenCalledOnce()
		expect(pulledAfterTurnEnd).toBe(false)
		// The final usage still arrives, so the header and metrics stay complete.
		expect(out.filter((chunk) => chunk.kind === "usage")).toHaveLength(1)
		const final = out.find((chunk) => chunk.kind === "final")
		if (final?.kind !== "final") throw new Error("missing final chunk")
		expect(final.blocks.map((block) => block.invocation.toolName)).toEqual(["make_plan"])
		expect(JSON.stringify(final.content)).not.toContain("AFTER_TURN_END")
	})

	it("keeps reading after a completed ordinary call, because later calls in the reply still run", async () => {
		const chunks = await run(
			[
				{
					type: "tool_calls",
					phase: "completed",
					function_id: "call_read",
					dline_tid: "tid_read",
					argumentsMode: "snapshot",
					tool_call: { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
				} as ApiStreamChunk,
				text("Then more."),
			],
			true,
		)

		const final = chunks.find((chunk) => chunk.kind === "final")
		expect(final).toMatchObject({ kind: "final", text: "Then more." })
	})

	it("records the model that produced the reply on the final chunk", async () => {
		const modelInfo = { modelId: "test-model", providerId: "anthropic", mode: "act" }
		const request = {
			api: streamingApi([text("hello")]),
			systemPrompt: "",
			nativeTools: false,
			mode: "serial",
			profile: "standard",
			messages: [],
			turnId: "turn-1",
			modelInfo,
			planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
		} as unknown as PreparedProviderRequest
		const chunks: ProductionProviderChunk[] = []
		const provider = new DefaultProductionProviderService({ requests: { prepare: async () => request } })
		for await (const chunk of provider.start({
			draftRef: "draft-1",
			draft: {} as ProviderDraftEnvelope,
			signal: new AbortController().signal,
		}))
			chunks.push(chunk)

		expect(chunks.find((chunk) => chunk.kind === "final")).toMatchObject({ kind: "final", modelInfo })
	})

	it("records markup calls as paired when the request offered no native tools", async () => {
		const chunks = await run([text(MARKUP)], false)

		const final = chunks.find((chunk) => chunk.kind === "final")
		if (final?.kind !== "final") throw new Error("missing final chunk")
		expect(final.content).toEqual([expect.objectContaining({ type: "tool_use", name: "summarize_task" })])
		expect(final.blocks.map((block) => block.invocation.resultReplay)).toEqual([undefined])
	})
})

/** One provider attempt: either it streams chunks or it fails before its first one. */
type Attempt = { readonly chunks: readonly ApiStreamChunk[] } | { readonly error: unknown }

function httpError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status })
}

const FROZEN_MESSAGES: ClineStorageMessage[] = [
	{ role: "user", content: [{ type: "text", text: "question" }] },
	{
		role: "assistant",
		content: [{ type: "tool_use", function_id: "call_1", dline_tid: "tid_1", name: "read_file", input: { path: "a.ts" } }],
	},
	// The call above never got its result: a pairing a provider rejects.
	{ role: "user", content: [{ type: "text", text: "next" }] },
]

/**
 * A provider whose attempts play out in order, and a factory that counts how
 * often the request had to be prepared.
 */
function scripted(attempts: readonly Attempt[], retry: Partial<ProviderRetryPolicy> = {}) {
	const sent: ClineStorageMessage[][] = []
	let call = 0
	const api = {
		createMessage: vi.fn(async function* (_system: string, messages: ClineStorageMessage[]) {
			sent.push(structuredClone(messages))
			const attempt = attempts[Math.min(call++, attempts.length - 1)]
			if ("error" in attempt) throw attempt.error
			for (const chunk of attempt.chunks) yield chunk
		}),
		getModel: () => ({ id: "test-model", info: {} }),
	} as unknown as ApiHandler
	const request = {
		api,
		systemPrompt: "frozen system prompt",
		nativeTools: false,
		mode: "serial",
		profile: "standard",
		messages: FROZEN_MESSAGES,
		turnId: "turn-1",
		planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
	} as unknown as PreparedProviderRequest
	const prepare = vi.fn(async () => request)
	const waits: number[] = []
	const policy: ProviderRetryPolicy = {
		maxAttempts: retry.maxAttempts ?? 5,
		delayMs: retry.delayMs ?? ((attempt) => attempt * 1000),
		wait:
			retry.wait ??
			(async (delayMs) => {
				waits.push(delayMs)
				return true
			}),
	}
	let id = 0
	const service = new DefaultProductionProviderService({
		requests: { prepare },
		nextPresentationId: () => ++id,
		retry: policy,
	})
	return { service, api, request, prepare, sent, waits }
}

async function collect(service: DefaultProductionProviderService, signal = new AbortController().signal) {
	const out: ProductionProviderChunk[] = []
	for await (const chunk of service.start({ draftRef: "draft-1", draft: {} as ProviderDraftEnvelope, signal })) out.push(chunk)
	return out
}

describe("DefaultProductionProviderService request retry", () => {
	it("replays the one frozen request after a transient failure and reports each retry", async () => {
		const harness = scripted([
			{ error: httpError(503, "Service Unavailable") },
			{ error: new Error("stream_read_error") },
			{ chunks: [text("Recovered answer.")] },
		])

		const chunks = await collect(harness.service)

		// Prepared once: a retry must not rebuild the prompt or re-read the journal.
		expect(harness.prepare).toHaveBeenCalledOnce()
		expect(harness.api.createMessage).toHaveBeenCalledTimes(3)
		expect(harness.sent[1]).toEqual(harness.sent[0])
		expect(harness.sent[2]).toEqual(harness.sent[0])
		expect(harness.waits).toEqual([1000, 2000])
		expect(chunks.filter((chunk) => chunk.kind === "retry")).toEqual([
			{ kind: "retry", notice: expect.objectContaining({ attempt: 1, maxAttempts: 5, delayMs: 1000 }) },
			{ kind: "retry", notice: expect.objectContaining({ attempt: 2, maxAttempts: 5, delayMs: 2000 }) },
		])
		expect(chunks.at(-1)).toMatchObject({ kind: "final", text: "Recovered answer." })
	})

	it("fails once the retry budget is spent", async () => {
		const failure = httpError(503, "Service Unavailable")
		const harness = scripted([{ error: failure }], { maxAttempts: 2 })

		await expect(collect(harness.service)).rejects.toBe(failure)
		expect(harness.api.createMessage).toHaveBeenCalledTimes(3)
	})

	it("treats a stream that ends without content as a failed attempt", async () => {
		const harness = scripted([{ chunks: [] }, { chunks: [text("second try")] }])

		const chunks = await collect(harness.service)

		expect(harness.api.createMessage).toHaveBeenCalledTimes(2)
		expect(chunks.at(-1)).toMatchObject({ kind: "final", text: "second try" })
	})

	it.each([
		["rejected credentials", httpError(401, "Unauthorized")],
		["a context the model cannot hold", httpError(400, "This model's maximum context length is 8192 tokens")],
		["spend limit", Object.assign(new Error("limit"), { status: 429, code: "SPEND_LIMIT_EXCEEDED" })],
	])("does not replay %s", async (_label, failure) => {
		const harness = scripted([{ error: failure }, { chunks: [text("never sent")] }])

		await expect(collect(harness.service)).rejects.toBe(failure)
		expect(harness.api.createMessage).toHaveBeenCalledOnce()
	})

	it("rebuilds the pairing exactly once when the provider rejects it", async () => {
		const pairing = httpError(400, "No tool output found for function call call_1.")
		const harness = scripted([{ error: pairing }, { chunks: [text("paired now")] }])

		const chunks = await collect(harness.service)

		expect(harness.api.createMessage).toHaveBeenCalledTimes(2)
		// Sent immediately: waiting cannot fix a deterministic rejection.
		expect(harness.waits).toEqual([])
		expect(chunks.some((chunk) => chunk.kind === "retry")).toBe(false)
		expect(harness.sent[1][2]?.content).toEqual([
			expect.objectContaining({ type: "tool_result", function_id: "call_1" }),
			{ type: "text", text: "next" },
		])
		// The shared frozen conversation is left as it was.
		expect(FROZEN_MESSAGES[2].content).toEqual([{ type: "text", text: "next" }])
		expect(chunks.at(-1)).toMatchObject({ kind: "final", text: "paired now" })
	})

	it("fails when the rebuilt pairing is rejected again", async () => {
		const first = httpError(400, "No tool output found for function call call_1.")
		const second = httpError(400, "No tool output found for function call call_1.")
		const harness = scripted([{ error: first }, { error: second }, { chunks: [text("never sent")] }])

		await expect(collect(harness.service)).rejects.toBe(second)
		expect(harness.api.createMessage).toHaveBeenCalledTimes(2)
	})

	it("ends quietly when cancellation interrupts the retry wait", async () => {
		const controller = new AbortController()
		const harness = scripted([{ error: httpError(503, "Service Unavailable") }], {
			wait: async () => {
				controller.abort()
				return false
			},
		})

		const chunks = await collect(harness.service, controller.signal)

		expect(harness.api.createMessage).toHaveBeenCalledOnce()
		expect(chunks.map((chunk) => chunk.kind)).toEqual(["retry"])
	})

	// BUGFIX-092 in the v2 runtime: the frozen prompt and tools are one
	// provider's projection, so a handler replaced by a Profile or Mode switch
	// must not be sent the previous provider's request.
	it("prepares the same turn again for a handler the task replaced during the retry wait", async () => {
		const sourceApi = {
			createMessage: vi.fn(async function* () {
				yield* []
				throw httpError(503, "Service Unavailable")
			}),
			getModel: () => ({ id: "source-model", info: {} }),
		} as unknown as ApiHandler
		const targetApi = {
			createMessage: vi.fn(async function* () {
				yield {
					type: "tool_calls",
					function_id: "call_target",
					dline_tid: "tid_target",
					argumentsMode: "snapshot",
					tool_call: { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
				} as ApiStreamChunk
			}),
			getModel: () => ({ id: "target-model", info: {} }),
		} as unknown as ApiHandler
		let current = sourceApi
		const requestFor = (api: ApiHandler, tools: unknown[] | undefined) =>
			({
				api,
				systemPrompt: api === sourceApi ? "source prompt" : "target prompt",
				tools,
				nativeTools: Boolean(tools?.length),
				mode: "serial",
				profile: "standard",
				messages: FROZEN_MESSAGES,
				turnId: "turn-1",
				isCurrent: () => current === api,
				planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
			}) as unknown as PreparedProviderRequest
		const targetTools = [{ type: "function", function: { name: "read_file" } }]
		const prepare = vi.fn(async (_draft: ProviderDraftEnvelope) =>
			current === sourceApi ? requestFor(sourceApi, undefined) : requestFor(targetApi, targetTools),
		)
		const service = new DefaultProductionProviderService({
			requests: { prepare },
			nextPresentationId: () => 1,
			retry: {
				maxAttempts: 5,
				delayMs: () => 1000,
				wait: async () => {
					// The user switches Profile while the retry countdown runs.
					current = targetApi
					return true
				},
			},
		})

		const chunks = await collect(service)

		expect(prepare).toHaveBeenCalledTimes(2)
		// The same turn: its authority and transient row stay the turn's own.
		expect(prepare.mock.calls[1][0]).toMatchObject({ turnId: "turn-1" })
		expect(sourceApi.createMessage).toHaveBeenCalledOnce()
		expect(targetApi.createMessage).toHaveBeenCalledOnce()
		expect(targetApi.createMessage).toHaveBeenCalledWith("target prompt", FROZEN_MESSAGES, targetTools, undefined)
		const final = chunks.find((chunk) => chunk.kind === "final")
		if (final?.kind !== "final") throw new Error("missing final chunk")
		// Read with the target request's native tools, not the source's markup reading.
		expect(final.content).toEqual([expect.objectContaining({ type: "tool_use", function_id: "call_target" })])
	})

	it("sends again at once, without spending a retry, when the replacement aborted the attempt", async () => {
		let current = "source"
		const abortedByRebuild = Object.assign(new Error("Request was aborted."), { name: "AbortError" })
		const apiFor = (name: string) =>
			({
				createMessage: vi.fn(async function* () {
					if (name === "source") {
						current = "target"
						throw abortedByRebuild
					}
					yield text(`answer from ${name}`)
				}),
				getModel: () => ({ id: `${name}-model`, info: {} }),
			}) as unknown as ApiHandler
		const prepare = vi.fn(async () => {
			const name = current
			return {
				api: apiFor(name),
				systemPrompt: "",
				nativeTools: false,
				mode: "serial",
				profile: "standard",
				messages: [],
				turnId: "turn-1",
				isCurrent: () => current === name,
				planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
			} as unknown as PreparedProviderRequest
		})
		const wait = vi.fn(async () => true)
		const service = new DefaultProductionProviderService({
			requests: { prepare },
			nextPresentationId: () => 1,
			retry: { maxAttempts: 5, delayMs: () => 1000, wait },
		})

		const chunks = await collect(service)

		expect(prepare).toHaveBeenCalledTimes(2)
		expect(wait).not.toHaveBeenCalled()
		expect(chunks.some((chunk) => chunk.kind === "retry")).toBe(false)
		expect(chunks.at(-1)).toMatchObject({ kind: "final", text: "answer from target" })
	})

	it("keeps replaying the frozen request while its handler is still the task's", async () => {
		const harness = scripted([{ error: httpError(503, "Service Unavailable") }, { chunks: [text("same request")] }])
		Object.assign(harness.request, { isCurrent: () => true })

		const chunks = await collect(harness.service)

		expect(harness.prepare).toHaveBeenCalledOnce()
		expect(harness.sent[1]).toEqual(harness.sent[0])
		expect(chunks.at(-1)).toMatchObject({ kind: "final", text: "same request" })
	})

	it("never replays once the stream produced its first chunk", async () => {
		const failure = httpError(503, "Service Unavailable")
		let call = 0
		const harness = scripted([{ chunks: [] }])
		;(harness.api as { createMessage: unknown }).createMessage = vi.fn(async function* () {
			call++
			yield text("partial answer")
			throw failure
		})

		await expect(collect(harness.service)).rejects.toBe(failure)
		expect(call).toBe(1)
	})
})
