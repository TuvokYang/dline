import {
    type ContextWindowCandidateEstimator,
    estimateContextWindowCandidate,
} from "@core/context/context-management/context-window-projection"
import type { SystemPromptComposition } from "@core/prompts/generators/system-prompt-composition"
import { apportionTokens, type DurableContextComposition } from "@shared/context-window-indicator"
import type { ClineStorageMessage } from "@shared/messages/content"
import cloneDeep from "clone-deep"
import type { CompactionProviderInput } from "./compaction/CompactionProviderInput"

const ENVIRONMENT_DETAILS_PATTERN = /^<environment_details>[\s\S]*<\/environment_details>$/i

export interface ContextWindowIndicatorSegments {
    durableContextTokens: number
    pendingSendTokens: number
    environmentTokens: number
    totalTokens: number
}

/** What an admitted ordinary request is measured at when it opens on the indicator. */
export interface ContextWindowRequestOpening {
    /** The local estimate of the complete request. */
    readonly estimatedTokens: number
    readonly estimatedTextBytes?: number
    readonly estimatedMediaTokens?: number
    readonly providerId?: string
    readonly modelId?: string
    readonly apiFormat?: number
    /** The occupancy the request is projected to reach, on the scale earlier reports set. */
    readonly projectedUsageTokens: number
    /** The estimate split into the history the request carries, the round's own input, and the environment. */
    readonly segments: ContextWindowIndicatorSegments
    /** The request prefix split by source, on the same estimate scale; absent when the prompt was not measured. */
    readonly durableComposition?: DurableContextComposition
}

export interface EstimateDurableCompositionInput extends ContextWindowCandidateEstimator {
    providerInput: CompactionProviderInput
    systemPromptComposition?: SystemPromptComposition
}

export interface EstimateContextWindowIndicatorSegmentsInput extends ContextWindowCandidateEstimator {
    providerInput: CompactionProviderInput
    /** Number of leading messages already represented by the durable segment. */
    durableMessageCount: number
}

export interface ProjectAuthoritativeContextWindowIndicatorSegmentsInput {
    projectedTotalTokens: number
    durableContextTokens: number
    estimatedEnvironmentTokens: number
}

/** Decompose one frozen Provider input into non-overlapping durable, pending-send, and environment segments. */
export function estimateContextWindowIndicatorSegments(
    input: EstimateContextWindowIndicatorSegmentsInput,
): ContextWindowIndicatorSegments {
    const estimator = { providerId: input.providerId, modelId: input.modelId, tokenPerByte: input.tokenPerByte }
    const totalTokens = estimateContextWindowCandidate(input.providerInput, estimator)
    const messagesWithoutEnvironment = stripLatestEnvironmentDetails(input.providerInput.messages)
    const withoutEnvironmentTokens = Math.min(
        totalTokens,
        estimateContextWindowCandidate({ ...input.providerInput, messages: messagesWithoutEnvironment }, estimator),
    )
    const environmentTokens = Math.max(0, totalTokens - withoutEnvironmentTokens)
    const durableMessageCount = Math.max(0, Math.min(messagesWithoutEnvironment.length, Math.floor(input.durableMessageCount)))
    const durableMessages = messagesWithoutEnvironment.slice(0, durableMessageCount)
    let durableContextTokens = Math.min(
        withoutEnvironmentTokens,
        estimateContextWindowCandidate({ ...input.providerInput, messages: durableMessages }, estimator),
    )
    let pendingSendTokens = Math.max(0, withoutEnvironmentTokens - durableContextTokens)

    // Rounding can collapse a very small pending message into the fixed request envelope.
    // Keep the pending phase observable by reclassifying one token without changing the frozen total.
    if (pendingSendTokens === 0 && durableMessageCount < messagesWithoutEnvironment.length && durableContextTokens > 0) {
        durableContextTokens--
        pendingSendTokens = 1
    }

    return {
        durableContextTokens,
        pendingSendTokens,
        environmentTokens,
        totalTokens,
    }
}

/**
 * Estimate the request prefix every round repeats, split by where it comes from.
 *
 * The system prompt and the tool definitions are measured with the same
 * estimator as the request itself; the prompt's estimate is then shared out by
 * the byte sizes its generator recorded. A composition that does not describe
 * this exact prompt is ignored rather than applied to different text.
 */
export function estimateDurableComposition(input: EstimateDurableCompositionInput): DurableContextComposition | undefined {
    const composition = input.systemPromptComposition
    const { systemPrompt } = input.providerInput
    if (!composition || composition.totalBytes <= 0 || composition.totalBytes !== Buffer.byteLength(systemPrompt, "utf8")) {
        return undefined
    }
    const estimator = { providerId: input.providerId, modelId: input.modelId, tokenPerByte: input.tokenPerByte }
    const prefixTokens = estimateContextWindowCandidate({ ...input.providerInput, messages: [] }, estimator)
    const promptTokens = Math.min(prefixTokens, estimateContextWindowCandidate({ systemPrompt, messages: [] }, estimator))
    const measuredBytes = [
        composition.userRulesBytes,
        composition.skillsBytes,
        composition.workflowsBytes,
        composition.toolDefinitionsBytes,
    ]
    const baseBytes = Math.max(0, composition.totalBytes - measuredBytes.reduce((total, bytes) => total + bytes, 0))
    const [basePrompt = 0, userRules = 0, skills = 0, workflows = 0, promptToolDefinitions = 0] = apportionTokens(
        [baseBytes, ...measuredBytes],
        promptTokens,
    )
    return {
        basePrompt,
        userRules,
        skills,
        workflows,
        // Native tool and server-tool definitions are what the prefix holds beyond the prompt.
        toolDefinitions: promptToolDefinitions + Math.max(0, prefixTokens - promptTokens),
    }
}

/** Re-express an estimated prefix on another scale, as when a provider count has replaced the estimate. */
export function scaleDurableComposition(composition: DurableContextComposition, factor: number): DurableContextComposition {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return composition
    const scale = (tokens: number) => Math.round(tokens * factor)
    return {
        basePrompt: scale(composition.basePrompt),
        userRules: scale(composition.userRules),
        skills: scale(composition.skills),
        workflows: scale(composition.workflows),
        toolDefinitions: scale(composition.toolDefinitions),
    }
}

/** Allocate one authoritative occupancy total without subtracting values from a different token-estimation baseline. */
export function projectAuthoritativeContextWindowIndicatorSegments(
    input: ProjectAuthoritativeContextWindowIndicatorSegmentsInput,
): ContextWindowIndicatorSegments {
    const totalTokens = normalizeTokens(input.projectedTotalTokens)
    const environmentTokens = Math.min(normalizeTokens(input.estimatedEnvironmentTokens), totalTokens)
    const durableContextTokens = Math.min(
        normalizeTokens(input.durableContextTokens),
        Math.max(0, totalTokens - environmentTokens),
    )
    const pendingSendTokens = Math.max(0, totalTokens - environmentTokens - durableContextTokens)

    return {
        durableContextTokens,
        pendingSendTokens,
        environmentTokens,
        totalTokens,
    }
}

function stripLatestEnvironmentDetails(messages: readonly ClineStorageMessage[]): ClineStorageMessage[] {
    const projected: ClineStorageMessage[] = cloneDeep(Array.from(messages))
    for (let messageIndex = projected.length - 1; messageIndex >= 0; messageIndex--) {
        const message = projected[messageIndex]
        if (!message || !Array.isArray(message.content)) continue
        for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
            const block = message.content[blockIndex]
            if (block?.type !== "text" || !ENVIRONMENT_DETAILS_PATTERN.test(block.text.trim())) continue
            message.content.splice(blockIndex, 1)
            return projected
        }
    }
    return projected
}

function normalizeTokens(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
