import { resolveCompactionWindowBudget } from "@core/context/context-management/compaction-window-budget"
import {
	type CompactTriggerOptions,
	computeSummarizeBudget,
	getContextWindowInfo,
	resolveCompactTriggerPolicy,
} from "@core/context/context-management/context-window-utils"
import type { ClineStorageMessage } from "@shared/messages/content"
import type { ProviderRequestFrame } from "../executors/provider/service/ProviderRequest"

/**
 * Summary output budget when the window leaves no measurable room for one.
 *
 * The estimate can overstate the input; sending with a bounded budget lets the
 * provider decide instead of refusing a request that may still fit.
 */
export const FALLBACK_SUMMARY_OUTPUT_TOKENS = 30_000

export interface CompactionRequestPlanInput {
	readonly frame: ProviderRequestFrame
	readonly sourceHistory: readonly ClineStorageMessage[]
	/** Renders the closing user message, stating the window budget it is given. */
	readonly closingRequest: (budgetGuidance: string) => string
	/** The auto-condense settings; the absolute cap narrows the window a request may use. */
	readonly triggerOptions?: CompactTriggerOptions
	/** Caller-imposed ceiling on the summary itself. */
	readonly summaryOutputLimitTokens?: number
}

export interface CompactionRequestPlan {
	readonly messages: ClineStorageMessage[]
	readonly maxOutputTokens: number
	/** False when the estimated input leaves no output room inside the window. */
	readonly fits: boolean
}

/**
 * Size one compaction request against the window it is sent into.
 *
 * The summary may use the model's own output ceiling, bounded by what the
 * window still holds after the request's input (WS-010 §2). A fixed small cap
 * truncates the summary of exactly the long conversations that need it most.
 */
export function planCompactionRequest(input: CompactionRequestPlanInput): CompactionRequestPlan {
	const ts = Date.now()
	const buildMessages = (budgetGuidance: string): ClineStorageMessage[] => [
		...input.sourceHistory,
		{ role: "user", content: [{ type: "text", text: input.closingRequest(budgetGuidance) }], ts },
	]
	const { api } = input.frame
	const model = api.getModel()
	const { contextWindow } = getContextWindowInfo(api)
	const policy = resolveCompactTriggerPolicy(contextWindow, computeSummarizeBudget(), input.triggerOptions)
	const { budget, messages } = resolveCompactionWindowBudget({
		contextWindow: policy.hardPassContextWindowTokens,
		maxOutputTokens: model.info.capabilities?.maxTokens,
		summaryOutputLimitTokens: input.summaryOutputLimitTokens,
		systemPrompt: input.frame.systemPrompt,
		tools: input.frame.tools,
		serverTools: input.frame.options?.serverTools,
		// The pressure that triggered this compaction was measured with the same estimator.
		estimator: { providerId: api.getProviderId?.(), modelId: model.id },
		buildMessages,
	})
	if (budget.decision === "ready") return { messages, maxOutputTokens: budget.providerOutputCap, fits: true }
	// Stating a zero hard limit would tell the model to write nothing, so the
	// request goes out without a budget block and with the bounded fallback,
	// which must still respect the model's own ceiling and the caller's.
	const fallback = Math.min(
		FALLBACK_SUMMARY_OUTPUT_TOKENS,
		positiveOr(model.info.capabilities?.maxTokens, FALLBACK_SUMMARY_OUTPUT_TOKENS),
		positiveOr(input.summaryOutputLimitTokens, FALLBACK_SUMMARY_OUTPUT_TOKENS),
	)
	return { messages: buildMessages(""), maxOutputTokens: fallback, fits: false }
}

function positiveOr(value: number | undefined, otherwise: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : otherwise
}
