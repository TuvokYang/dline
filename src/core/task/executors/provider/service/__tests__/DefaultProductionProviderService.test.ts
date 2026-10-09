import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it, vi } from "vitest"
import type { ApiRequestTiming } from "../../../../performance/api-request-timing"
import { ProfileNotValidError } from "../../../../profile-admission"
import type { ProviderDraftEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk } from "../../ProductionProviderAdapter"
import { presentationOf } from "../../ProviderFailure"
import {
	DefaultProductionProviderService,
	type ProviderContextRecoveryPort,
	type ProviderRetryPolicy,
} from "../DefaultProductionProviderService"
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A service whose preparation, first chunk and later chunks each take `phaseMs`, reporting its timing. */
function timedService(phaseMs: number, timings: ApiRequestTiming[]) {
	const request = {
		api: {
			createMessage: async function* () {
				for (const value of ["one", "two"]) {
					await sleep(phaseMs)
					yield text(value)
				}
			},
			getModel: () => ({ id: "test-model", info: {} }),
		} as unknown as ApiHandler,
		systemPrompt: "",
		nativeTools: true,
		mode: "serial",
		profile: "standard",
		messages: [],
		turnId: "turn-1",
	} as unknown as PreparedProviderRequest
	return new DefaultProductionProviderService({
		requests: {
			prepare: async () => {
				await sleep(phaseMs)
				return request
			},
		},
		onRequestTiming: (timing) => timings.push(timing),
	})
}

describe("DefaultProductionProviderService", () => {
	// The multi-task pressure E2E reads this timing to tell the time Dline spends
	// preparing a request from the time the provider takes to answer it.
	it("reports one timing per completed request, split at the send and the first chunk", async () => {
		const timings: ApiRequestTiming[] = []
		const stream = timedService(40, timings).start({
			draftRef: "draft-1",
			draft: {} as ProviderDraftEnvelope,
			signal: new AbortController().signal,
		})
		for await (const _chunk of stream) {
			// Drain the request to its end.
		}

		expect(timings).toHaveLength(1)
		const [timing] = timings
		expect(timing.localPrepareMs).toBeGreaterThanOrEqual(30)
		expect(timing.upstreamTtfbMs).toBeGreaterThanOrEqual(30)
		expect(timing.streamMs).toBeGreaterThanOrEqual(30)
		expect(timing.totalMs).toBeGreaterThanOrEqual(timing.localPrepareMs + timing.upstreamTtfbMs)
	})

	it("reports no timing for a request the user cancelled", async () => {
		const timings: ApiRequestTiming[] = []
		const controller = new AbortController()
		const stream = timedService(5, timings).start({
			draftRef: "draft-1",
			draft: {} as ProviderDraftEnvelope,
			signal: controller.signal,
		})
		for await (const chunk of stream) {
			if (chunk.kind === "partial") controller.abort()
		}

		expect(timings).toEqual([])
	})

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

	// Claude Code answers a markup-described request with native tool_use
	// blocks. Reading that reply as markup only discarded the call, so the
	// turn looked empty and the task asked the model to use a tool again.
	it("keeps a native call a provider returned to a markup-described request", async () => {
		const chunks = await run(
			[
				{
					type: "tool_calls",
					function_id: "call_native",
					dline_tid: "tid_native",
					tool_call: { function: { name: "attempt_completion", arguments: '{"result":' } },
				} as ApiStreamChunk,
				{
					type: "tool_calls",
					function_id: "call_native",
					dline_tid: "tid_native",
					tool_call: { function: { name: "attempt_completion", arguments: '"DONE"}' } },
				} as ApiStreamChunk,
				{
					type: "tool_calls",
					function_id: "call_native",
					dline_tid: "tid_native",
					phase: "completed",
					argumentsMode: "delta",
					tool_call: { function: { name: "attempt_completion", arguments: "" } },
				} as ApiStreamChunk,
			],
			false,
		)

		const final = chunks.find((chunk) => chunk.kind === "final")
		if (final?.kind !== "final") throw new Error("missing final chunk")
		expect(final.content).toEqual([
			expect.objectContaining({
				type: "tool_use",
				function_id: "call_native",
				name: "attempt_completion",
				input: { result: "DONE" },
			}),
		])
		expect(final.blocks).toEqual([
			expect.objectContaining({
				invocation: expect.objectContaining({
					toolName: "attempt_completion",
					isNativeToolCall: true,
					input: { result: "DONE" },
				}),
			}),
		])
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

	it("streams reasoning as it arrives and keeps it on the settled turn", async () => {
		const chunks = await run(
			[
				{ type: "reasoning", reasoning: "THINK_" } as ApiStreamChunk,
				{ type: "reasoning", reasoning: "MORE" } as ApiStreamChunk,
				text("Answer."),
			],
			true,
		)

		const partials = chunks.filter((chunk) => chunk.kind === "partial")
		expect(partials.map((chunk) => (chunk.kind === "partial" ? chunk.reasoning : undefined))).toEqual([
			"THINK_",
			"THINK_MORE",
			undefined,
		])
		expect(chunks.find((chunk) => chunk.kind === "final")).toMatchObject({ reasoning: "THINK_MORE", text: "Answer." })
	})

	// dev showed the response filling the window while it streamed; without it
	// the header froze on the request's input until the final usage arrived.
	it("reports what the response occupies while it streams, then the provider's own output", async () => {
		const usage = (inputTokens: number, outputTokens: number) =>
			({ type: "usage", inputTokens, outputTokens, cacheReadTokens: 1_000, cacheWriteTokens: 500 }) as ApiStreamChunk
		const chunks = await run([usage(5_500, 0), text("x".repeat(400)), text("y".repeat(400)), usage(0, 30)], true)

		const receiving = chunks.filter((chunk) => chunk.kind === "receiving")
		expect(receiving).toEqual([
			// The provider reports the input first: the figure is already its own.
			{ kind: "receiving", receivingTokens: 0, authoritativeContextTokens: 7_000 },
			// Until it reports output, the received part is the generated text's estimate.
			{ kind: "receiving", receivingTokens: 100, authoritativeContextTokens: 7_000 },
			{ kind: "receiving", receivingTokens: 200, authoritativeContextTokens: 7_000 },
			// Its own output count then replaces the estimate.
			{ kind: "receiving", receivingTokens: 30, authoritativeContextTokens: 7_030 },
		])
		// Occupancy is presentation only; the settled turn is unchanged.
		expect(chunks.find((chunk) => chunk.kind === "final")).toMatchObject({ text: `${"x".repeat(400)}${"y".repeat(400)}` })
	})

	// dev kept a stopped reply as an assistant message closed by an interruption
	// notice, so the next request continued from what the model had said.
	it("reports what a stopped reply already said, without the call it was still writing", async () => {
		const controller = new AbortController()
		const api = {
			createMessage: async function* () {
				yield { type: "reasoning", reasoning: "PARTIAL_THOUGHT", signature: "partial-signature" } as ApiStreamChunk
				yield text("Partial answer")
				controller.abort()
				yield {
					type: "tool_calls",
					function_id: "call_cut",
					dline_tid: "tid_cut",
					argumentsMode: "snapshot",
					tool_call: { function: { name: "attempt_completion", arguments: '{"result":"NEVER"}' } },
				} as ApiStreamChunk
			},
			getModel: () => ({ id: "test-model", info: {} }),
		} as unknown as ApiHandler
		const request = {
			api,
			systemPrompt: "",
			nativeTools: true,
			mode: "serial",
			profile: "standard",
			messages: [],
			turnId: "turn-1",
			planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
		} as unknown as PreparedProviderRequest
		const out: ProductionProviderChunk[] = []
		for await (const chunk of new DefaultProductionProviderService({ requests: { prepare: async () => request } }).start({
			draftRef: "draft-1",
			draft: {} as ProviderDraftEnvelope,
			signal: controller.signal,
		}))
			out.push(chunk)

		expect(out.some((chunk) => chunk.kind === "final")).toBe(false)
		expect(out.at(-1)).toEqual({
			kind: "interrupted",
			transientId: "provider:turn-1",
			text: "Partial answer",
			reasoning: "PARTIAL_THOUGHT",
			content: [
				{
					type: "thinking",
					thinking: "PARTIAL_THOUGHT",
					signature: "partial-signature",
					summary: [],
					provider_metadata: undefined,
				},
				{ type: "text", text: "Partial answer\n\n[Response interrupted by user]" },
			],
		})
		expect(JSON.stringify(out)).not.toContain("NEVER")
	})

	// Anthropic cannot abort a pending read: Cancel must not wait for the
	// provider to end the stream, or Resume stays unavailable until it does.
	it("settles a cancelled reply before an un-abortable read ends, and drops what arrives after", async () => {
		const controller = new AbortController()
		let holdEntered!: () => void
		let releaseHold!: () => void
		const holding = new Promise<void>((resolve) => {
			holdEntered = resolve
		})
		const held = new Promise<void>((resolve) => {
			releaseHold = resolve
		})
		let sourceClosed = false
		const createMessage = vi.fn(async function* () {
			try {
				yield text("Partial answer")
				holdEntered()
				// Deliberately ignores the abort, like a transport without one.
				await held
				yield text(" LATE_TEXT")
				yield { type: "usage", inputTokens: 1, outputTokens: 1 } as ApiStreamChunk
			} finally {
				sourceClosed = true
			}
		})
		const request = {
			api: { createMessage, getModel: () => ({ id: "test-model", info: {} }) } as unknown as ApiHandler,
			systemPrompt: "",
			nativeTools: true,
			mode: "serial",
			profile: "standard",
			messages: [],
			turnId: "turn-1",
			planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
		} as unknown as PreparedProviderRequest
		const out: ProductionProviderChunk[] = []
		const collected = (async () => {
			for await (const chunk of new DefaultProductionProviderService({ requests: { prepare: async () => request } }).start({
				draftRef: "draft-1",
				draft: {} as ProviderDraftEnvelope,
				signal: controller.signal,
			}))
				out.push(chunk)
		})()

		await holding
		controller.abort("cancelled")
		const settledWhileHeld = await Promise.race([
			collected.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
		])
		// Release the source either way, so a regression fails here instead of hanging.
		releaseHold()
		await collected
		await vi.waitFor(() => expect(sourceClosed).toBe(true))

		expect(settledWhileHeld).toBe(true)
		expect(out.at(-1)).toMatchObject({ kind: "interrupted", transientId: "provider:turn-1", text: "Partial answer" })
		expect(out.some((chunk) => chunk.kind === "final")).toBe(false)
		expect(JSON.stringify(out)).not.toContain("LATE_TEXT")
		expect(createMessage).toHaveBeenCalledOnce()
	})

	// Anthropic drops a thinking block it did not sign, and the Responses API
	// replays reasoning from its summary and encrypted items, so the journaled
	// turn must keep what the provider attached, not only the visible text.
	it("keeps the signature, summary and encrypted reasoning the provider attached for replay", async () => {
		const chunks = await run(
			[
				{
					type: "reasoning",
					reasoning: "",
					redacted_data: "ENCRYPTED_ITEM",
					redacted_phase: "final",
					provider_metadata: { response_id: "rs_1" },
				} as ApiStreamChunk,
				{ type: "reasoning", reasoning: "SIGNED_THOUGHT" } as ApiStreamChunk,
				{
					type: "reasoning",
					reasoning: "",
					signature: "SIGNATURE_1",
					details: { type: "summary_text", text: "SUMMARY_1" },
				} as ApiStreamChunk,
				text("Answer"),
			],
			true,
		)

		const final = chunks.find((chunk) => chunk.kind === "final")
		expect(final).toMatchObject({ reasoning: "SIGNED_THOUGHT" })
		expect(final && "content" in final ? final.content : undefined).toEqual([
			{ type: "redacted_thinking", data: "ENCRYPTED_ITEM", provider_metadata: { response_id: "rs_1" } },
			{
				type: "thinking",
				thinking: "SIGNED_THOUGHT",
				signature: "SIGNATURE_1",
				summary: [{ type: "summary_text", text: "SUMMARY_1" }],
				provider_metadata: { response_id: "rs_1" },
			},
			{ type: "text", text: "Answer" },
		])
	})

	it("opens one contentless reasoning partial for encrypted-only reasoning and never forwards the ciphertext", async () => {
		const encrypted = (data: string) =>
			({
				type: "reasoning",
				reasoning: "",
				redacted_data: data,
				redacted_phase: "partial",
				provider_metadata: { response_id: "rs_1" },
			}) as ApiStreamChunk
		const chunks = await run([encrypted("CIPHER_1"), encrypted("CIPHER_2"), text("Answer")], true)

		const reasoningPartials = chunks.filter((chunk) => chunk.kind === "partial" && "reasoning" in chunk)
		expect(reasoningPartials).toEqual([expect.objectContaining({ kind: "partial", reasoning: "", text: "" })])
		const presented = chunks.filter((chunk) => chunk.kind === "partial" || chunk.kind === "final")
		expect(JSON.stringify(presented.map((chunk) => ({ ...chunk, content: undefined })))).not.toContain("CIPHER")
		expect(chunks.find((chunk) => chunk.kind === "final")).not.toHaveProperty("reasoning")
	})

	it("reports nothing for a reply stopped before it said anything", async () => {
		const controller = new AbortController()
		const api = {
			createMessage: async function* () {
				controller.abort()
				yield text("")
			},
			getModel: () => ({ id: "test-model", info: {} }),
		} as unknown as ApiHandler
		const request = {
			api,
			systemPrompt: "",
			nativeTools: true,
			mode: "serial",
			profile: "standard",
			messages: [],
			turnId: "turn-1",
			planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
		} as unknown as PreparedProviderRequest
		const out: ProductionProviderChunk[] = []
		for await (const chunk of new DefaultProductionProviderService({ requests: { prepare: async () => request } }).start({
			draftRef: "draft-1",
			draft: {} as ProviderDraftEnvelope,
			signal: controller.signal,
		}))
			out.push(chunk)

		expect(out.filter((chunk) => chunk.kind === "interrupted" || chunk.kind === "final")).toEqual([])
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
function scripted(
	attempts: readonly Attempt[],
	retry: Partial<ProviderRetryPolicy> = {},
	contextRecovery?: ProviderContextRecoveryPort,
	rounds?: ConstructorParameters<typeof DefaultProductionProviderService>[0]["rounds"],
) {
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
				return "send" as const
			}),
		...(retry.claimManualTakeover ? { claimManualTakeover: retry.claimManualTakeover } : {}),
	}
	let id = 0
	const service = new DefaultProductionProviderService({
		requests: { prepare },
		nextPresentationId: () => ++id,
		retry: policy,
		contextRecovery,
		rounds,
	})
	return { service, api, request, prepare, sent, waits }
}

async function collect(service: DefaultProductionProviderService, signal = new AbortController().signal) {
	const out: ProductionProviderChunk[] = []
	for await (const chunk of service.start({ draftRef: "draft-1", draft: {} as ProviderDraftEnvelope, signal })) out.push(chunk)
	return out
}

/** The provider's own failure, unwrapped from the description the service attaches for the chat. */
async function failureOf(service: DefaultProductionProviderService): Promise<unknown> {
	try {
		await collect(service)
	} catch (error) {
		return error instanceof Error && error.cause !== undefined ? error.cause : error
	}
	throw new Error("expected the request to fail")
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

	it("replays upstream_http2_stream_error as the same frozen turn", async () => {
		const failure = Object.assign(
			new Error(
				JSON.stringify({
					error: {
						code: "upstream_http2_stream_error",
						message: "The upstream HTTP/2 stream was reset.",
						type: "upstream_error",
					},
				}),
			),
			{ code: "upstream_http2_stream_error", status: 502 },
		)
		const harness = scripted([{ error: failure }, { chunks: [text("Recovered HTTP/2 answer.")] }])

		const chunks = await collect(harness.service)

		expect(harness.prepare).toHaveBeenCalledOnce()
		expect(harness.api.createMessage).toHaveBeenCalledTimes(2)
		expect(harness.sent[1]).toEqual(harness.sent[0])
		expect(harness.waits).toEqual([1000])
		expect(chunks.filter((chunk) => chunk.kind === "retry")).toEqual([
			{ kind: "retry", notice: expect.objectContaining({ attempt: 1, maxAttempts: 5, delayMs: 1000 }) },
		])
		expect(chunks.at(-1)).toMatchObject({ kind: "final", text: "Recovered HTTP/2 answer." })
	})

	it("fails once the retry budget is spent", async () => {
		const failure = httpError(503, "Service Unavailable")
		const harness = scripted([{ error: failure }], { maxAttempts: 2 })

		expect(await failureOf(harness.service)).toBe(failure)
		expect(harness.api.createMessage).toHaveBeenCalledTimes(3)
	})

	it("returns a manual Retry's failure to the user without a second automatic sequence", async () => {
		const failure = httpError(503, "Service Unavailable")
		const harness = scripted([{ error: failure }], { maxAttempts: 5, claimManualTakeover: () => true })

		expect(await failureOf(harness.service)).toBe(failure)
		expect(harness.api.createMessage).toHaveBeenCalledTimes(1)
		expect(harness.waits).toEqual([])
	})

	// As in dev, a request the Profile cannot admit goes straight to the error
	// box: only fixing or switching the Profile can change its outcome.
	it("fails a request its Profile cannot admit at once, with no retry countdown", async () => {
		const failure = new ProfileNotValidError(
			'Profile not valid: "azure" requires an Azure endpoint for Azure Identity authentication.',
		)
		const harness = scripted([{ error: failure }], { maxAttempts: 5 })

		expect(await failureOf(harness.service)).toBe(failure)
		expect(harness.api.createMessage).toHaveBeenCalledTimes(1)
		expect(harness.waits).toEqual([])
	})

	// The chat's error box explains a failure in the provider's words. The
	// kernel only keeps a sanitized kind, so the description has to leave the
	// service with the failure, without replacing it.
	it("hands a failure after the stream started to the chat with its description", async () => {
		const failure = httpError(403, "Profile not valid")
		const api = {
			createMessage: async function* () {
				yield text("partial")
				throw failure
			},
			getModel: () => ({ id: "test-model", info: {} }),
		} as unknown as ApiHandler
		const request = {
			api,
			systemPrompt: "",
			nativeTools: false,
			mode: "serial",
			profile: "standard",
			messages: [],
			turnId: "turn-1",
			planTool: () => ({ attempt: "a", lanes: [], turnEnding: false, approval: { kind: "none" } }),
		} as unknown as PreparedProviderRequest
		const service = new DefaultProductionProviderService({ requests: { prepare: async () => request } })

		const thrown = await collect(service).catch((error: unknown) => error)

		expect(presentationOf(thrown)).toContain("Profile not valid")
		expect((thrown as Error).cause).toBe(failure)
		expect((thrown as Error).name).toBe(failure.name)
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

		expect(await failureOf(harness.service)).toBe(failure)
		expect(harness.api.createMessage).toHaveBeenCalledOnce()
	})

	it("rebuilds the pairing exactly once when the provider rejects it", async () => {
		const pairing = httpError(
			400,
			"messages.188: `tool_use` ids were found without `tool_result` blocks immediately after: call_1. Each `tool_use` block must have a corresponding `tool_result` block in the next message.",
		)
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

		expect(await failureOf(harness.service)).toBe(second)
		expect(harness.api.createMessage).toHaveBeenCalledTimes(2)
	})

	it("ends quietly when cancellation interrupts the retry wait", async () => {
		const controller = new AbortController()
		const harness = scripted([{ error: httpError(503, "Service Unavailable") }], {
			wait: async () => {
				controller.abort()
				return "cancelled" as const
			},
		})

		const chunks = await collect(harness.service, controller.signal)

		expect(harness.api.createMessage).toHaveBeenCalledOnce()
		expect(chunks.map((chunk) => chunk.kind)).toEqual(["retry"])
	})

	it("fails with the retried error, sending nothing more, when the user takes the countdown back", async () => {
		const rateLimited = httpError(429, "Too Many Requests")
		const harness = scripted([{ error: rateLimited }, { chunks: [text("never sent")] }], {
			wait: async () => "handed_back" as const,
		})

		expect(await failureOf(harness.service)).toBe(rateLimited)
		expect(harness.api.createMessage).toHaveBeenCalledOnce()
	})

	// BUGFIX-092 in the task runtime: the frozen prompt and tools are one
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
					return "send" as const
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
		const wait = vi.fn(async () => "send" as const)
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

	// dev retried a stream that failed mid-way (an idle timeout after reasoning);
	// prose and reasoning are transient rows the resent stream rewrites.
	it("replays a stream that failed after showing only prose, sharing the retry budget", async () => {
		const failure = httpError(503, "Service Unavailable")
		let call = 0
		const harness = scripted([{ chunks: [] }])
		;(harness.api as { createMessage: unknown }).createMessage = vi.fn(async function* () {
			call++
			yield text(call === 1 ? "partial answer" : "Recovered answer.")
			if (call === 1) throw failure
		})

		const chunks = await collect(harness.service)

		expect(call).toBe(2)
		expect(harness.prepare).toHaveBeenCalledOnce()
		expect(harness.waits).toEqual([1000])
		expect(chunks.filter((chunk) => chunk.kind === "retry")).toEqual([
			{ kind: "retry", notice: expect.objectContaining({ attempt: 1, maxAttempts: 5, delayMs: 1000 }) },
		])
		const final = chunks.at(-1)
		expect(final).toMatchObject({ kind: "final", text: "Recovered answer." })
		expect(JSON.stringify(final)).not.toContain("partial answer")
	})

	it("fails a mid-stream failure once the budget the first attempts spent is gone", async () => {
		const failure = httpError(503, "Service Unavailable")
		let call = 0
		const harness = scripted([{ chunks: [] }], { maxAttempts: 1 })
		;(harness.api as { createMessage: unknown }).createMessage = vi.fn(async function* () {
			call++
			if (call === 1) throw failure
			yield text("partial answer")
			throw failure
		})

		expect(await failureOf(harness.service)).toBe(failure)
		expect(call).toBe(2)
	})

	it("never replays once the stream called a tool", async () => {
		const failure = httpError(503, "Service Unavailable")
		let call = 0
		const harness = scripted([{ chunks: [] }])
		;(harness.api as { createMessage: unknown }).createMessage = vi.fn(async function* () {
			call++
			yield {
				type: "tool_calls",
				phase: "delta",
				function_id: "fn-1",
				dline_tid: "tid-1",
				tool_call: { function: { id: "fn-1", name: "read_file", arguments: "{" } },
			} as unknown as ApiStreamChunk
			throw failure
		})

		expect(await failureOf(harness.service)).toBe(failure)
		expect(call).toBe(1)
	})

	// The rate metrics count logical requests: every send of the turn's request,
	// retries included, belongs to the one round the turn opened.
	it("binds every send of a turn's request to the turn's round with its attempt number", async () => {
		const bound: Array<[string, number]> = []
		const bindOrdinaryAttempt = <T>(turnId: string, attempt: number, stream: AsyncIterable<T>): AsyncIterable<T> => {
			bound.push([turnId, attempt])
			return stream
		}
		const harness = scripted(
			[{ error: httpError(503, "Service Unavailable") }, { chunks: [text("Recovered answer.")] }],
			{},
			undefined,
			{ bindOrdinaryAttempt },
		)

		await collect(harness.service)

		expect(bound).toEqual([
			["turn-1", 0],
			["turn-1", 1],
		])
	})
})

describe("DefaultProductionProviderService context-window recovery", () => {
	const tooLong = () => httpError(400, "This request exceeds the model's maximum context window.")

	function recovery(enabled: boolean, positions: ReadonlyArray<{ seq: number } | undefined>) {
		let next = 0
		return {
			enabled: () => enabled,
			truncate: vi.fn(async () => positions[Math.min(next++, positions.length - 1)]),
		}
	}

	it("truncates and resends at once, through the truncation, without spending a retry", async () => {
		const port = recovery(true, [{ seq: 42 }])
		const harness = scripted([{ error: tooLong() }, { chunks: [text("Recovered answer.")] }], {}, port)

		const chunks = await collect(harness.service)

		expect(port.truncate).toHaveBeenCalledOnce()
		expect(harness.api.createMessage).toHaveBeenCalledTimes(2)
		expect(chunks.filter((chunk) => chunk.kind === "retry")).toEqual([])
		expect(harness.waits).toEqual([])
		expect(harness.prepare).toHaveBeenCalledTimes(2)
		expect(harness.prepare).toHaveBeenLastCalledWith(
			expect.objectContaining({ journalThrough: { seq: 42 } }),
			expect.anything(),
		)
	})

	it("waits out a retry before each later truncation, until the retry budget is spent", async () => {
		const failure = tooLong()
		const port = recovery(true, [{ seq: 1 }, { seq: 2 }, { seq: 3 }])
		const harness = scripted([{ error: failure }], { maxAttempts: 2 }, port)

		expect(await failureOf(harness.service)).toBe(failure)
		expect(port.truncate).toHaveBeenCalledTimes(3)
		expect(harness.api.createMessage).toHaveBeenCalledTimes(4)
		expect(harness.waits).toEqual([1000, 2000])
		expect(harness.prepare).toHaveBeenLastCalledWith(
			expect.objectContaining({ journalThrough: { seq: 3 } }),
			expect.anything(),
		)
	})

	it("fails with the refusal once nothing settled is left to remove", async () => {
		const failure = tooLong()
		const port = recovery(true, [undefined])
		const harness = scripted([{ error: failure }], {}, port)

		expect(await failureOf(harness.service)).toBe(failure)
		expect(port.truncate).toHaveBeenCalledOnce()
		expect(harness.api.createMessage).toHaveBeenCalledOnce()
	})

	it("leaves the refusal to the task when auto-compaction owns the context window", async () => {
		const failure = tooLong()
		const port = recovery(false, [{ seq: 1 }])
		const harness = scripted([{ error: failure }], {}, port)

		expect(await failureOf(harness.service)).toBe(failure)
		expect(port.truncate).not.toHaveBeenCalled()
		expect(harness.api.createMessage).toHaveBeenCalledOnce()
	})
})

describe("DefaultProductionProviderService endpoint projection", () => {
	const attachedPdf = {
		type: "attached_document",
		path: "/work/spec.pdf",
		media_type: "application/pdf",
		data: "JVBERi0xLjQK",
		byte_length: 9,
		fallback_text: "EXTRACTED_PDF_TEXT",
	}

	function withPdf(documentInput?: { maxTotalBytes: number }) {
		const harness = scripted([{ chunks: [text("ok")] }])
		;(harness.request as { messages: ClineStorageMessage[] }).messages = [
			{ role: "user", content: [{ type: "text", text: "read this" }, attachedPdf] } as ClineStorageMessage,
		]
		;(harness.api as { getDocumentInputLimits?: unknown }).getDocumentInputLimits = () => documentInput
		return harness
	}

	it("sends an attached PDF as a native document when the endpoint reads PDFs", async () => {
		const harness = withPdf({ maxTotalBytes: 1_000 })

		await collect(harness.service)

		const content = harness.sent[0][0].content as Array<{ type: string }>
		expect(content.some((block) => block.type === "document")).toBe(true)
		expect(content.some((block) => block.type === "attached_document")).toBe(false)
	})

	it("sends the extracted text of an attached PDF to an endpoint that cannot read PDFs", async () => {
		const harness = withPdf(undefined)

		await collect(harness.service)

		const content = harness.sent[0][0].content as Array<{ type: string; text?: string }>
		expect(content.some((block) => block.type === "document" || block.type === "attached_document")).toBe(false)
		expect(content.some((block) => block.text?.includes("EXTRACTED_PDF_TEXT"))).toBe(true)
	})
})
