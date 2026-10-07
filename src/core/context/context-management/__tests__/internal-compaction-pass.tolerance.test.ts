import { OutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { CompactionAttemptDiagnostics } from "../compaction-attempt-diagnostics"
import { CompactionAuthorizationError, CompactionSummaryRejectedError } from "../compaction-attempt-failure"
import { runInternalCompactionPass } from "../internal-compaction-pass"

/**
 * Regression guard for task 1791122313218.
 *
 * The model wrote a complete summary, but the reply ended with `</context>` instead of
 * `</context></summarize_task>`, or carried text after the closing tag. The old parser required
 * the trimmed reply to end with the closing tag, so every retry replayed the same request and
 * failed the same way. A closed block is now accepted regardless of what follows it, and every
 * rejection names the structural defect without recording reply text.
 */

const SUMMARY = "User asked to fix the parser; tests remain."

function usageChunk(stopReason?: "output_limit" | "end_turn") {
	return {
		type: "usage" as const,
		inputTokens: 9_000,
		outputTokens: 1_200,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		...(stopReason ? { stopReason } : {}),
	}
}

function createStream(chunks: unknown[], failure?: unknown) {
	return (async function* () {
		for (const chunk of chunks) yield chunk
		if (failure) throw failure
	})()
}

function runPass(chunks: unknown[], options: { failure?: unknown; authorized?: boolean } = {}) {
	const settled: CompactionAttemptDiagnostics[] = []
	const consumeTool = vi.fn(() =>
		options.authorized === false ? { ok: false as const, code: "scope_closed" } : { ok: true as const },
	)
	const result = runInternalCompactionPass({
		api: { createMessage: vi.fn(() => createStream(chunks, options.failure)) } as never,
		providerInput: { systemPrompt: "system", messages: [], tools: [], serverTools: [] } as never,
		explicitInstructions: { beginProviderAttempt: vi.fn(), createConsumePort: () => ({ consumeTool }) } as never,
		attemptId: "attempt-0",
		onAttemptSettled: (diagnostics) => settled.push(diagnostics),
	})
	return { result, settled, consumeTool }
}

function text(value: string) {
	return { type: "text" as const, text: value }
}

describe("internal compaction Pass reply tolerance", () => {
	it("accepts a closed block followed by trailing text and reports only its length", async () => {
		const trailing = "\nLet me know if anything else is needed."
		const { result, settled, consumeTool } = runPass([
			text(`<summarize_task>\n<context>\n${SUMMARY}\n</context>\n</summarize_task>${trailing}`),
			usageChunk("end_turn"),
		])

		await expect(result).resolves.toMatchObject({ summary: SUMMARY })
		expect(consumeTool).toHaveBeenCalledWith(ClineDefaultTool.SUMMARIZE_TASK)
		expect(settled).toEqual([
			expect.objectContaining({ outcome: "accepted", trailingChars: trailing.length, stopReason: "end_turn" }),
		])
		expect(JSON.stringify(settled)).not.toContain(SUMMARY)
	})

	it("accepts a call as soon as the streamed reply ends with it, like any closed tool call", async () => {
		const { result } = runPass([
			text("<summarize_task><context>draft summary</context></summarize_task>\n"),
			text("<summarize_task><context>revised final summary</context></summarize_task>"),
			usageChunk(),
		])

		await expect(result).resolves.toMatchObject({ summary: "draft summary" })
	})

	it("keeps a repeated invocation in one chunk inside one call because inner closes read as quoted text", async () => {
		const { result } = runPass([
			text(
				"<summarize_task><context>draft summary</context></summarize_task>\n<summarize_task><context>revised final summary</context></summarize_task>",
			),
			usageChunk(),
		])

		await expect(result).resolves.toMatchObject({
			summary: "draft summary</context></summarize_task>\n<summarize_task><context>revised final summary",
		})
	})

	it("continues before the Provider usage tail arrives and attaches that usage afterwards", async () => {
		let releaseTail = (): void => {}
		const tailGate = new Promise<void>((resolve) => {
			releaseTail = resolve
		})
		const attachExactUsage = vi.fn()
		const stream = (async function* () {
			yield text(`<summarize_task>\n<context>\n${SUMMARY}\n</context>\n</summarize_task>`)
			await tailGate
			yield usageChunk("end_turn")
		})()
		const result = runInternalCompactionPass({
			api: { createMessage: vi.fn(() => stream) } as never,
			providerInput: { systemPrompt: "system", messages: [], tools: [], serverTools: [] } as never,
			explicitInstructions: {
				beginProviderAttempt: vi.fn(),
				createConsumePort: () => ({ consumeTool: () => ({ ok: true as const }) }),
			} as never,
			attemptId: "attempt-0",
			providerRequestRound: { bindAttempt: (source: unknown) => source, attachExactUsage } as never,
		})

		await expect(result).resolves.toMatchObject({ summary: SUMMARY })
		expect(attachExactUsage).not.toHaveBeenCalled()
		releaseTail()
		await vi.waitFor(() =>
			expect(attachExactUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 9_000, outputTokens: 1_200 })),
		)
	})

	it("keeps closing tags quoted inside the summary because only the final close terminates the call", async () => {
		const quoted = 'Fixed the parser for "</context></summarize_task>" quoting.\nTests pass.'
		const { result, settled } = runPass([
			text(`<summarize_task>\n<context>\n${quoted}\n</context>\n</summarize_task>`),
			usageChunk("end_turn"),
		])

		await expect(result).resolves.toMatchObject({ summary: quoted })
		expect(settled[0]).toMatchObject({ outcome: "accepted", trailingChars: 0 })
	})

	it("returns the optional task_progress parameter of the accepted call", async () => {
		const { result } = runPass([
			text(
				`<summarize_task>\n<context>\n${SUMMARY}\n</context>\n<task_progress>\n- [x] Fix parser\n</task_progress>\n</summarize_task>`,
			),
			usageChunk(),
		])

		await expect(result).resolves.toMatchObject({ summary: SUMMARY, taskProgress: "- [x] Fix parser" })
	})

	it("keeps a closed block when the Provider stops at the output limit afterwards", async () => {
		const { result, settled } = runPass(
			[text(`<summarize_task>\n<context>\n${SUMMARY}\n</context>\n</summarize_task>\nextra`), usageChunk()],
			{ failure: new OutputLimitExceededError("openai_chat", "length") },
		)

		await expect(result).resolves.toMatchObject({ summary: SUMMARY })
		expect(settled[0]).toMatchObject({ outcome: "accepted", trailingChars: "\nextra".length })
	})

	it("rejects a reply whose block never closes as unclosed_block", async () => {
		const { result, settled } = runPass([
			text(`<summarize_task>\n<context>\n${SUMMARY}\n</context>\n`),
			usageChunk("end_turn"),
		])

		const error = await result.catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(CompactionSummaryRejectedError)
		expect(error).toMatchObject({ failureKind: "unclosed_block" })
		expect(settled).toEqual([
			expect.objectContaining({
				outcome: "failed",
				failureKind: "unclosed_block",
				textChunks: 1,
				textChars: `<summarize_task>\n<context>\n${SUMMARY}\n</context>\n`.length,
			}),
		])
		expect(JSON.stringify(settled)).not.toContain(SUMMARY)
	})

	it.each([
		{ name: "prose without an invocation", reply: `Summary: ${SUMMARY}`, kind: "missing_block" },
		{ name: "a call without context", reply: "<summarize_task>\n</summarize_task>", kind: "missing_context" },
		{
			name: "a call with blank context",
			reply: "<summarize_task>\n<context>\n  \n</context>\n</summarize_task>",
			kind: "empty_context",
		},
		{ name: "a context that never closes", reply: `<summarize_task>\n<context>\n${SUMMARY}`, kind: "unclosed_context" },
	])("classifies $name as $kind", async ({ reply, kind }) => {
		const { result, settled } = runPass([text(reply), usageChunk("end_turn")])

		await expect(result).rejects.toMatchObject({ failureKind: kind })
		expect(settled[0]).toMatchObject({ outcome: "failed", failureKind: kind })
	})

	it("classifies an unclosed reply cut by the output limit as output_limit", async () => {
		const { result, settled } = runPass([text(`<summarize_task>\n<context>\n${SUMMARY}`), usageChunk("output_limit")])

		await expect(result).rejects.toMatchObject({ failureKind: "output_limit" })
		expect(settled[0]).toMatchObject({ failureKind: "output_limit", stopReason: "output_limit" })
	})

	it("rejects a native tool call and reports an undeclared tool name as unknown", async () => {
		const { result, settled } = runPass([
			{
				type: "tool_calls",
				function_id: "call_1",
				tool_call: {
					function: { name: ClineDefaultTool.SUMMARIZE_TASK, arguments: JSON.stringify({ context: SUMMARY }) },
				},
			},
			usageChunk(),
		])

		await expect(result).rejects.toMatchObject({ failureKind: "foreign_tool_call" })
		expect(settled[0]).toMatchObject({ failureKind: "foreign_tool_call", toolCallChunks: 1, toolNames: ["unknown"] })
		expect(JSON.stringify(settled)).not.toContain(SUMMARY)
	})

	it("rejects a reply with no text as empty_response", async () => {
		const { result, settled } = runPass([usageChunk()])

		await expect(result).rejects.toMatchObject({ failureKind: "empty_response" })
		expect(settled[0]).toMatchObject({ outcome: "failed", failureKind: "empty_response", textChars: 0 })
	})

	it("reports the Provider failure instead of the block shape when the stream breaks", async () => {
		const providerFailure = new Error("503 Service Unavailable")
		const { result, settled } = runPass([text("<summarize_task>\n<context>\npartial")], { failure: providerFailure })

		await expect(result).rejects.toBe(providerFailure)
		expect(settled[0]).toMatchObject({ outcome: "failed", failureKind: "provider_error" })
	})

	it("fails closed when the explicit-instruction scope refuses the summary", async () => {
		const { result, settled } = runPass(
			[text(`<summarize_task><context>${SUMMARY}</context></summarize_task>`), usageChunk()],
			{
				authorized: false,
			},
		)

		await expect(result).rejects.toBeInstanceOf(CompactionAuthorizationError)
		expect(settled[0]).toMatchObject({ outcome: "failed", failureKind: "authorization_failed" })
	})
})
