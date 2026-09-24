import type { CompactTriggerOptions } from "@core/context/context-management/context-window-utils"
import type { ClineStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import type { ProductionCompactionService } from "../executors/compaction/ProductionCompactionAdapter"
import type { ProviderRequestFrame, ProviderRequestFramePort } from "../executors/provider/service/ProviderRequest"
import { planCompactionRequest } from "./CompactionRequestPlan"
import type { CompactionRequestScopeReader } from "./CompactionRequestScopes"
import { normalizeCompactionResponse } from "./CompactionResponseNormalizer"
import {
	foldNativeCompactionSummary,
	type NativeCompactionSummaryState,
	readNativeCompactionSummary,
} from "./NativeCompactionSummary"

export interface ProviderCompactionServiceOptions {
	/** The frame ordinary requests use; compaction must share it to keep the provider prefix cache. */
	readonly frames: ProviderRequestFramePort
	/**
	 * Renders the summarize instruction appended after the source conversation.
	 *
	 * It receives the resolved frame because the instruction must describe the
	 * same prompt profile the frame's system prompt was rendered for, and the
	 * window budget block the instruction must state to the model.
	 */
	readonly instruction: (frame: ProviderRequestFrame, budgetGuidance: string) => string
	/** The auto-condense settings; absent means the provider window alone bounds the request. */
	readonly triggerOptions?: () => CompactTriggerOptions
	/**
	 * The handler a run is sent under when it is not the task's own, as for a
	 * context transition that compacts for the target it is about to adopt.
	 */
	readonly scopes?: CompactionRequestScopeReader
}

interface CompactionContext {
	readonly sourceHistory: ClineStorageMessage[]
	/** Caller-imposed ceiling on the summary; the window budget still applies below it. */
	readonly maxOutputTokens?: number
	/** What the user asked this summary to keep; part of this request only. */
	readonly guidance?: string
	/** Why the user rejected the previous summary; part of the regenerated request only. */
	readonly feedback?: string
}

/**
 * The closing message of a compaction request.
 *
 * The user's own words follow the instruction so the model reads them as
 * constraints on this summary. They are never journaled: once the summary
 * lands, the guidance has done its work and must not reappear in later turns.
 */
function renderRequest(instruction: string, context: CompactionContext): string {
	const parts = [instruction]
	if (context.guidance?.trim()) parts.push(`<user_guidance>\n${context.guidance.trim()}\n</user_guidance>`)
	if (context.feedback?.trim()) parts.push(`<summary_feedback>\n${context.feedback.trim()}\n</summary_feedback>`)
	return parts.join("\n\n")
}

function isCompactionContext(value: unknown): value is CompactionContext {
	return Boolean(value && typeof value === "object" && Array.isArray((value as { sourceHistory?: unknown }).sourceHistory))
}

function extractSummary(assistantText: string): string {
	const match = /<summarize_task>\s*<context>([\s\S]*?)<\/context>\s*<\/summarize_task>/.exec(assistantText)
	if (!match) throw new Error("Compaction response did not contain summarize_task context")
	const summary = match[1].trim()
	if (!summary) throw new Error("Compaction response contained an empty context")
	return summary
}

/**
 * Runs one provider-backed compaction request outside the ordinary turn stream.
 *
 * The request is the ordinary request with one more user message: the same
 * handler, system prompt, tools and task namespace, followed by the source
 * conversation and then the summarize instruction. Everything before the
 * instruction is therefore a prefix the provider has already cached, so the
 * compaction reads the conversation it condenses from cache instead of
 * re-sending it as a new prompt.
 */
export class ProviderCompactionService implements ProductionCompactionService {
	constructor(private readonly options: ProviderCompactionServiceOptions) {}

	async run(input: Parameters<ProductionCompactionService["run"]>[0]): Promise<unknown> {
		if (!isCompactionContext(input.context)) throw new Error("InvalidCompactionContext")
		if (input.signal.aborted) throw input.signal.reason
		const frame = await this.options.frames.frame(input.signal, this.options.scopes?.resolve(input.compactionId))
		// A stop during frame resolution happened before the listener below exists.
		if (input.signal.aborted) throw input.signal.reason
		const context = input.context
		const plan = planCompactionRequest({
			frame,
			sourceHistory: context.sourceHistory,
			closingRequest: (budgetGuidance) => renderRequest(this.options.instruction(frame, budgetGuidance), context),
			triggerOptions: this.options.triggerOptions?.(),
			summaryOutputLimitTokens: context.maxOutputTokens,
		})
		if (!plan.fits) {
			Logger.warn(
				`[Compaction] ${input.compactionId}: estimated input leaves no output room in the window; sending with fallback budget ${plan.maxOutputTokens}`,
			)
		}
		const abort = () => frame.api.abort?.()
		input.signal.addEventListener("abort", abort, { once: true })
		let assistantText = ""
		// A provider with native tools answers with a `summarize_task` call, so the
		// summary never reaches the text channel this method otherwise reads.
		let nativeSummary: NativeCompactionSummaryState = {}
		try {
			const stream = frame.api.createMessage(frame.systemPrompt, plan.messages, frame.tools, {
				...frame.options,
				generation: { purpose: "compaction", maxOutputTokens: plan.maxOutputTokens },
			})
			for await (const chunk of stream) {
				if (input.signal.aborted) throw input.signal.reason
				if (chunk.type === "tool_calls") {
					nativeSummary = foldNativeCompactionSummary(nativeSummary, {
						functionId: chunk.function_id,
						name: chunk.tool_call.function.name,
						arguments: chunk.tool_call.function.arguments,
						argumentsMode: chunk.argumentsMode,
					})
					continue
				}
				if (chunk.type !== "text") continue
				assistantText += chunk.text
				input.publish({
					kind: "compaction_partial",
					compactionId: input.compactionId,
					attempt: input.attempt,
					text: normalizeCompactionResponse(assistantText).assistantText,
				})
			}
		} finally {
			input.signal.removeEventListener("abort", abort)
		}
		const normalized = normalizeCompactionResponse(assistantText).assistantText
		const summary = readNativeCompactionSummary(nativeSummary)
		// The prose still carries whatever the model said around the call, so the
		// stored transcript stays faithful even when the summary came natively.
		return summary
			? { summary, assistantText: normalized }
			: { summary: extractSummary(normalized), assistantText: normalized }
	}
}
