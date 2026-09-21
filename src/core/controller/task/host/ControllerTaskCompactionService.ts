import { summarizeTask } from "@core/prompts/contextManagement"
import { normalizeCompactionResponse } from "@core/task/compaction/CompactionResponseNormalizer"
import type { ProductionCompactionService } from "@core/task/executors/compaction/ProductionCompactionAdapter"
import type { TaskApiHandlerOwner } from "@core/task/session/TaskApiHandlerOwner"
import type { ClineStorageMessage } from "@shared/messages/content"

export interface ControllerCompactionContext {
	readonly sourceHistory: ClineStorageMessage[]
	readonly focusChainEnabled?: boolean
	readonly cwd?: string
	readonly multiRoot?: boolean
	readonly maxOutputTokens?: number
}

function isCompactionContext(value: unknown): value is ControllerCompactionContext {
	return Boolean(value && typeof value === "object" && Array.isArray((value as { sourceHistory?: unknown }).sourceHistory))
}

function extractSummary(assistantText: string): string {
	const match = /<summarize_task>\s*<context>([\s\S]*?)<\/context>\s*<\/summarize_task>/.exec(assistantText)
	if (!match) throw new Error("Compaction response did not contain summarize_task context")
	const summary = match[1].trim()
	if (!summary) throw new Error("Compaction response contained an empty context")
	return summary
}

/** Runs one real provider-backed compaction request outside the ordinary turn stream. */
export class ControllerTaskCompactionService implements ProductionCompactionService {
	constructor(
		private readonly api: TaskApiHandlerOwner,
		private readonly taskNamespace: string,
	) {}

	async run(input: Parameters<ProductionCompactionService["run"]>[0]): Promise<unknown> {
		if (!isCompactionContext(input.context)) throw new Error("InvalidControllerCompactionContext")
		if (input.signal.aborted) throw input.signal.reason
		const api = this.api.current()
		const abort = () => api.abort?.()
		input.signal.addEventListener("abort", abort, { once: true })
		let assistantText = ""
		try {
			const stream = api.createMessage(
				summarizeTask({ enabled: input.context.focusChainEnabled === true }, input.context.cwd, input.context.multiRoot),
				input.context.sourceHistory,
				undefined,
				{
					taskNamespace: this.taskNamespace,
					generation: {
						purpose: "compaction",
						maxOutputTokens: input.context.maxOutputTokens ?? 30_000,
					},
				},
			)
			for await (const chunk of stream) {
				if (input.signal.aborted) throw input.signal.reason
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
		return { summary: extractSummary(normalized), assistantText: normalized }
	}
}
