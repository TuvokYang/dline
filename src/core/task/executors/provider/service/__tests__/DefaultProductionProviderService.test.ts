import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import { describe, expect, it } from "vitest"
import type { ProviderDraftEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk } from "../../ProductionProviderAdapter"
import { DefaultProductionProviderService } from "../DefaultProductionProviderService"
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

	it("records markup calls as paired when the request offered no native tools", async () => {
		const chunks = await run([text(MARKUP)], false)

		const final = chunks.find((chunk) => chunk.kind === "final")
		if (final?.kind !== "final") throw new Error("missing final chunk")
		expect(final.content).toEqual([expect.objectContaining({ type: "tool_use", name: "summarize_task" })])
		expect(final.blocks.map((block) => block.invocation.resultReplay)).toEqual([undefined])
	})
})
