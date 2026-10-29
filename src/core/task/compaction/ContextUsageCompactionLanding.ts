import type { ClineStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import type { ProviderRequestFramePort } from "../executors/provider/service/ProviderRequest"
import type { CompactionLandingInput, CompactionLandingPort } from "./CompactionSummaryLanding"
import { estimateFramedRequest } from "./FramedRequestEstimate"

/** Receives the occupancy of the conversation a summary left behind. */
export interface CondensedContextUsagePort {
    compacted(input: { readonly contextTokens: number; readonly contextWindow: number }): void
}

export interface ContextUsageCompactionLandingOptions {
    /** The frame ordinary requests use, so the figure is the request the next round would send. */
    readonly frames: ProviderRequestFramePort
    /** The provider messages after the summary replaced the history it stands for. */
    readonly conversation: { messages(): Promise<ClineStorageMessage[]> }
    readonly usage: CondensedContextUsagePort
}

/**
 * Measures the condensed conversation once a summary has landed.
 *
 * It runs after the conversation landing, so the messages it reads are the
 * ones the next request will carry. The figure only informs the view and the
 * switches that read it: an estimate that cannot be taken is logged and the
 * landing stands, because the history has already been condensed.
 */
export class ContextUsageCompactionLanding implements CompactionLandingPort {
    constructor(private readonly options: ContextUsageCompactionLandingOptions) {}

    async land(input: CompactionLandingInput): Promise<void> {
        try {
            const messages = await this.options.conversation.messages()
            const estimate = await estimateFramedRequest(
                this.options.frames,
                messages,
                input.signal ?? new AbortController().signal,
            )
            this.options.usage.compacted({ contextTokens: estimate.tokens, contextWindow: estimate.contextWindow })
        } catch (error) {
            Logger.warn(
                `[ContextUsage] could not measure the context after compaction ${input.compactionId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            )
        }
    }
}
