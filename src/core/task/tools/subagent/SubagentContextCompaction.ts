import { randomUUID } from "node:crypto"
import type { ApiHandler } from "@core/api"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { compactionSummaryMessage } from "@core/context/context-management/compaction-summary-message"
import { estimateContextWindowCandidate } from "@core/context/context-management/context-window-projection"
import type { CompactTriggerOptions } from "@core/context/context-management/context-window-utils"
import type { PromptProfile } from "@core/prompts/profiles/types"
import { renderCompactionInstruction } from "@core/task/compaction/CompactionInstruction"
import { type ProviderCompactionResult, ProviderCompactionService } from "@core/task/compaction/ProviderCompactionService"
import type { ProviderRequestFrame } from "@core/task/executors/provider/service/ProviderRequest"
import type { ClineStorageMessage } from "@shared/messages"
import type { ClineTool } from "@shared/tools"
import type { TaskConfig } from "../types/TaskConfig"

export function subagentCompactTriggerOptions(config: TaskConfig): CompactTriggerOptions {
    const settings = config.services.stateManager
    return {
        triggerPercent: settings.getGlobalSettingsKey("autoCondenseTriggerPercent"),
        minReserveTokens: settings.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
        maxReserveTokens: settings.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
        maxContextTokens: settings.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
    }
}

export interface SubagentCompactionInput {
    readonly api: ApiHandler
    readonly config: TaskConfig
    readonly systemPrompt: string
    readonly tools: ClineTool[] | undefined
    readonly profile: PromptProfile
    readonly webSearchRoutingPlan: WebSearchRoutingPlan
    readonly messages: ClineStorageMessage[]
    readonly signal: AbortSignal
    readonly environment?: string
}

/** Reuse Main's summarizer without journal, checkpoint, cards or recovery state. */
export async function compactSubagentConversation(input: SubagentCompactionInput): Promise<ClineStorageMessage[]> {
    const { api, config, messages, signal } = input
    const providerId = api.getProviderId?.() ?? "unknown"
    const frame: ProviderRequestFrame = {
        api,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        options: { taskNamespace: config.taskId, serverTools: input.webSearchRoutingPlan.serverTools },
        nativeTools: Boolean(input.tools?.length),
        mode: "serial",
        profile: input.profile,
        serverToolContext: {
            providerId,
            webSearchRoutingPlan: input.webSearchRoutingPlan,
            imageGeneration: { enabled: false, providerId, modelId: api.getModel().id },
        },
    }
    const service = new ProviderCompactionService({
        frames: { frame: async () => frame },
        triggerOptions: () => subagentCompactTriggerOptions(config),
        environment: { preview: async () => input.environment },
        instruction: (_frame, budgetGuidance) =>
            renderCompactionInstruction({
                cwd: config.cwd,
                profile: input.profile,
                focusChain: { enabled: false },
                multiRoot: config.isMultiRootEnabled === true,
                budgetGuidance,
            }),
    })
    const compactionId = randomUUID()
    const result = (await service.run({
        compactionId,
        attempt: `${compactionId}:1`,
        trigger: "automatic",
        context: {
            sourceHistory: messages,
            // Memory indexes identify the accepted prefix, including partial multi-Pass coverage.
            sourceRanges: messages.map((_, index) => [index, index]),
        },
        signal,
        publish: () => undefined,
    })) as ProviderCompactionResult
    signal.throwIfAborted()
    if (result.coveredThrough === undefined) throw new Error("Subagent compaction returned no covered conversation range.")
    const summary = compactionSummaryMessage(result.summary)
    // Keep the server-required workspace metadata on the new opening message.
    if (input.environment && Array.isArray(summary.content)) summary.content.push({ type: "text", text: input.environment })
    return [summary, ...messages.slice(result.coveredThrough + 1)]
}

export function estimateSubagentContext(
    input: Pick<SubagentCompactionInput, "api" | "systemPrompt" | "tools" | "webSearchRoutingPlan" | "messages">,
): number {
    return estimateContextWindowCandidate(
        {
            systemPrompt: input.systemPrompt,
            messages: input.messages,
            tools: input.tools,
            serverTools: input.webSearchRoutingPlan.serverTools,
        },
        { providerId: input.api.getProviderId?.(), modelId: input.api.getModel().id },
    )
}

/** Preserve the old no-summary overflow recovery independently of automatic compaction. */
export function truncateSubagentConversation(
    contextManager: ContextManager,
    conversation: ClineStorageMessage[],
    previousRange: [number, number] | undefined,
): { didCompact: boolean; conversationHistoryDeletedRange: [number, number] | undefined } {
    const optimization = contextManager.attemptFileReadOptimizationInMemory(conversation, undefined, Date.now())
    if (optimization.anyContextUpdates) {
        conversation.splice(0, conversation.length, ...(optimization.optimizedConversationHistory as ClineStorageMessage[]))
        if (!optimization.needToTruncate) return { didCompact: true, conversationHistoryDeletedRange: previousRange }
    }
    const range = contextManager.getNextTruncationRange(conversation, previousRange, "quarter")
    const changed = range[1] >= range[0] && (!previousRange || range[0] !== previousRange[0] || range[1] !== previousRange[1])
    return {
        didCompact: optimization.anyContextUpdates || changed,
        conversationHistoryDeletedRange: changed ? range : previousRange,
    }
}
