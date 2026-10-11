import { randomUUID } from "node:crypto"
import { resolveContextWindowProjection } from "@core/context/context-management/context-window-projection"
import {
    type CompactTriggerOptions,
    computeCompactTrigger,
    computeSummarizeBudget,
} from "@core/context/context-management/context-window-utils"
import type { ClineStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { NO_COMPLETE_LOGICAL_TURN } from "../ContextCompactionSession"
import {
    type ContextWindowRequestOpening,
    estimateContextWindowIndicatorSegments,
    estimateDurableComposition,
} from "../ContextWindowIndicatorProjection"
import { getHighContextPressureWarning, withHighContextPressureWarning } from "../environment-context"
import type { CompactionFailurePresentationPort } from "../executors/compaction/ProductionCompactionAdapter"
import type { ComposeContextWindowGuardPort, ContextWindowAdmission } from "../executors/compose/ProductionComposeAdapter"
import type { ProviderRequestFramePort } from "../executors/provider/service/ProviderRequest"
import { AUTOMATIC_COMPACTION_FAILED, AUTOMATIC_COMPACTION_WITHDRAWN } from "./CompactionRoundBarrier"
import { estimateFramedRequest, type FramedRequestEstimate } from "./FramedRequestEstimate"

type RequestPressures = Parameters<typeof resolveContextWindowProjection>[0]["requestInfos"]
type Projection = ReturnType<typeof resolveContextWindowProjection>

/** How a compaction the guard asked for ended. */
export type AdmissionCompaction =
    | { readonly kind: "completed" }
    /** Nothing ran: compaction is off, or this round already compacted. */
    | { readonly kind: "skipped" }
    /** Nothing answered exists yet, so there is nothing a summary could replace. */
    | { readonly kind: "nothing_to_compact" }
    /** The run was cancelled or abandoned, so the request it was making room for must not go out. */
    | { readonly kind: "withdrawn" }
    | { readonly kind: "failed"; readonly error: string }

/** Compacts for a round whose complete request does not fit; owned by the compaction barrier. */
export interface AdmissionCompactionPort {
    compactForAdmission(signal: AbortSignal): Promise<AdmissionCompaction>
}

export interface FinalContextWindowGuardOptions {
    readonly taskId: string
    /** The frame ordinary requests use, so the measured system prompt and tools are the ones sent. */
    readonly frames: ProviderRequestFramePort
    /** The provider messages the round's draft will carry, its own inputs included. */
    readonly conversation: { messages(): Promise<ClineStorageMessage[]> }
    /** What earlier requests reported, the baseline the candidate is measured against. */
    readonly requestPressures: () => RequestPressures
    readonly triggerOptions: () => CompactTriggerOptions
    /** Absent in assemblies that never compact; the guard then only measures and warns. */
    readonly compaction?: AdmissionCompactionPort
    /** Shows why a round that could not be compacted stopped. */
    readonly failure?: CompactionFailurePresentationPort
}

interface Measurement {
    readonly estimate: FramedRequestEstimate
    readonly projection: Projection
    /** Leading messages that were already sent before this round; the rest is the round's own input. */
    readonly sentMessageCount: number
    readonly apiIndex: number
}

/**
 * The last word on whether a round's request fits, taken on the request itself.
 *
 * The usage the previous request reported only bounds the history; this round
 * adds its inputs, its environment, and possibly a different system prompt.
 * Measuring the complete candidate is what lets the very first request of a
 * task stop before the provider when it can never fit, and what tells the
 * model, inside the request it reads, that the window is nearly full.
 */
export class FinalContextWindowGuard implements ComposeContextWindowGuardPort {
    private admitted: ContextWindowRequestOpening | undefined

    constructor(private readonly options: FinalContextWindowGuardOptions) {}

    /**
     * The estimate of the request most recently admitted.
     *
     * Recorded with the request so its reported usage has an anchor: the next
     * round's growth is the difference between two estimates, not between an
     * estimate and a figure the provider counts differently.
     */
    admittedEstimate(): number | undefined {
        return this.admitted?.estimatedTokens
    }

    /** The request most recently admitted, as the context-window indicator opens it. */
    admittedRequest(): ContextWindowRequestOpening | undefined {
        return this.admitted
    }

    async admit(input: { readonly signal: AbortSignal; readonly environment?: string }): Promise<ContextWindowAdmission> {
        let environment = input.environment
        let measured = await this.measure(input.signal, environment)
        if (measured.projection.shouldCompact && this.options.compaction) {
            const compaction = await this.options.compaction.compactForAdmission(input.signal)
            if (compaction.kind === "nothing_to_compact") return await this.refuseUncompactable()
            if (compaction.kind === "withdrawn") return { kind: "withdrawn", reason: AUTOMATIC_COMPACTION_WITHDRAWN }
            if (compaction.kind === "failed") {
                return { kind: "failed", reason: AUTOMATIC_COMPACTION_FAILED, presentation: compaction.error }
            }
            if (compaction.kind === "completed") measured = await this.measure(input.signal, environment)
        }
        const warning = getHighContextPressureWarning({
            contextWindow: measured.estimate.contextWindow,
            lastApiReqTotalTokens: measured.projection.projectedUsageTokens,
            modelId: measured.estimate.modelId,
        })
        if (warning && environment !== undefined) {
            const warned = withHighContextPressureWarning(environment, warning)
            if (warned !== environment) {
                environment = warned
                measured = await this.measure(input.signal, environment)
            }
        }
        this.admitted = this.admission(measured)
        this.log(measured)
        return { kind: "ready", ...(environment === undefined ? {} : { environment }) }
    }

    private async measure(signal: AbortSignal, environment: string | undefined): Promise<Measurement> {
        const history = await this.options.conversation.messages()
        const messages: ClineStorageMessage[] =
            environment === undefined ? history : [...history, { role: "user", content: [{ type: "text", text: environment }] }]
        const estimate = await estimateFramedRequest(this.options.frames, messages, signal)
        const projection = resolveContextWindowProjection({
            requestInfos: this.options.requestPressures(),
            candidateEstimatedTokens: estimate.tokens,
            contextWindow: estimate.contextWindow,
            triggerTokens: computeCompactTrigger(estimate.contextWindow, computeSummarizeBudget(), this.options.triggerOptions()),
        })
        return {
            estimate,
            projection,
            // The round's own input is the latest message; the environment, when
            // present, follows it as a message of its own.
            sentMessageCount: Math.max(0, history.length - 1),
            apiIndex: apiIndexOf(history),
        }
    }

    /**
     * Splits the admitted request the way its sending state shows it.
     *
     * Only the request that is actually sent is split, so the extra measuring
     * happens once per round rather than on every measurement admission takes.
     */
    private admission(measured: Measurement): ContextWindowRequestOpening {
        const { estimate, projection } = measured
        const durableComposition = estimateDurableComposition({
            providerInput: estimate.input,
            systemPromptComposition: estimate.systemPromptComposition,
            providerId: estimate.providerId,
            modelId: estimate.modelId,
        })
        return {
            estimatedTokens: estimate.tokens,
            estimatedTextBytes: estimate.textBytes,
            estimatedMediaTokens: estimate.mediaTokens,
            providerId: estimate.providerId,
            modelId: estimate.modelId,
            apiFormat: estimate.apiFormat,
            projectedUsageTokens: projection.projectedUsageTokens,
            segments: estimateContextWindowIndicatorSegments({
                providerInput: estimate.input,
                durableMessageCount: measured.sentMessageCount,
                providerId: estimate.providerId,
                modelId: estimate.modelId,
            }),
            ...(durableComposition ? { durableComposition } : {}),
        }
    }

    /**
     * Stop a round that does not fit and cannot be condensed.
     *
     * Nothing has been answered yet, so no summary could replace anything and
     * sending the request would only fail at the provider. No run happened, so
     * the card a failed run writes is written here.
     */
    private async refuseUncompactable(): Promise<ContextWindowAdmission> {
        const compactionId = `compaction:admission:${randomUUID()}`
        await this.options.failure?.present({ compactionId, attempt: `${compactionId}:1`, error: NO_COMPLETE_LOGICAL_TURN })
        return { kind: "failed", reason: AUTOMATIC_COMPACTION_FAILED, presentation: NO_COMPLETE_LOGICAL_TURN }
    }

    private log(measured: Measurement): void {
        const { projection } = measured
        // One object argument, so everything after the prefix is the JSON a
        // diagnostic reader can parse.
        Logger.debug(`[Task ${this.options.taskId}] final context-window projection`, {
            apiIndex: measured.apiIndex,
            candidateEstimatedTokens: measured.estimate.tokens,
            contextWindow: measured.estimate.contextWindow,
            baselineTokens: projection.baselineTokens,
            pendingDeltaTokens: projection.pendingDeltaTokens,
            candidateDeltaTokens: projection.candidateDeltaTokens,
            projectedUsageTokens: projection.projectedUsageTokens,
            pressureSource: projection.pressureSource,
            shouldCompact: projection.shouldCompact,
        })
    }
}

/**
 * The ordinal of this request among the task's ordinary requests, as the
 * alternating history counts it: two messages per answered turn before it.
 */
function apiIndexOf(history: readonly ClineStorageMessage[]): number {
    return history.filter((message) => message.role === "assistant").length * 2
}
