import type { ProviderAttemptIdentity, ProviderAttemptObserver } from "@shared/provider-attempt-observer"
import { Logger } from "@shared/services/Logger"
import { ulid } from "ulid"
import { projectUsageModelId } from "@/services/telemetry/remote/contracts/modelIdentity"
import type { BlockPhase, KernelBlock } from "../kernel"
import type { UsageToolCall } from "../telemetry/UsageToolCalls"
import type { ApiRequestRoundScopeInput } from "./api-request-round-lifecycle"
import type { ApiRequestRoundHandle } from "./api-request-round-tracker"
import type { ApiRequestRoundUsage } from "./api-request-round-types"
import type { ApiResponseExecutionToolSummary } from "./api-response-execution-types"
import type { ProviderRequestRoundAdmission, ProviderRequestRoundAdmissionInput } from "./provider-request-round-port"
import type { ServingMetricsIdentity } from "./TaskPerformanceOwner"

interface ProviderRequestRoundLifecyclePort {
    createObserver(input: ApiRequestRoundScopeInput): ProviderAttemptObserver<ApiRequestRoundHandle>
    attachExactUsage(handle: ApiRequestRoundHandle, usage: ApiRequestRoundUsage): void
    finalizeTokens(handle: ApiRequestRoundHandle): void
    expectTools(logicalRequestId: string): void
    completeProviderOnly(logicalRequestId: string): void
    completeTools(logicalRequestId: string, summary: ApiResponseExecutionToolSummary, toolCalls?: readonly UsageToolCall[]): void
    completeTurnEndAwaitingUser(
        logicalRequestId: string,
        summary: ApiResponseExecutionToolSummary,
        toolCalls?: readonly UsageToolCall[],
    ): void
}

export type ProviderExecutionBlock = Pick<KernelBlock, "blockId" | "phase"> & { readonly invocationRef?: string }

export interface ProviderExecutionRegistration {
    readonly turnId: string
    readonly toolCount: number
    readonly turnEndInteractions: readonly { readonly interactionId: string; readonly blockId: string }[]
}

export interface TaskProviderRequestRoundOwnerOptions {
    readonly lifecycle: ProviderRequestRoundLifecyclePort
    readonly readExecutionBlocks: (turnId: string) => readonly ProviderExecutionBlock[]
    readonly isExecutionCancelling: () => boolean
    readonly resolveExecutionToolCalls?: (
        blocks: readonly ProviderExecutionBlock[],
        awaitingBlockId?: string,
    ) => Promise<readonly UsageToolCall[]>
    readonly readPolicyGeneration?: () => number | undefined
    /** The Profile a send is actually served under, sampled once per admission. */
    readonly readServingIdentity?: () => ServingMetricsIdentity | undefined
}

type ActiveProviderExecution = ProviderExecutionRegistration

interface TurnEndProviderExecution {
    readonly turnId: string
    readonly blockId: string
    readonly toolCount: number
    readonly admission: ProviderRequestRoundAdmission
}

/** Owns logical Provider request rounds and their response-execution completion lifecycle. */
export class TaskProviderRequestRoundOwner {
    private readonly ordinaryRounds = new Map<number, ProviderRequestRoundAdmission>()
    private readonly activeExecutions = new Map<ProviderRequestRoundAdmission, ActiveProviderExecution>()
    private readonly turnEndExecutions = new Map<string, TurnEndProviderExecution>()
    private readonly completedAdmissions = new Set<ProviderRequestRoundAdmission>()
    /**
     * The last attempt handle that reached a terminal, per admission.
     *
     * Keyed by the admission instead of by api index: ordinary rounds and auxiliary
     * sends allocate their indexes from separate counters that both start at zero, so
     * a bare index would let one send read another send's terminal.
     */
    private readonly latestTerminals = new WeakMap<ProviderRequestRoundAdmission, ApiRequestRoundHandle>()
    private readonly pendingCompletions = new Set<Promise<void>>()
    /** Who served each admitted round, frozen when the send was admitted. */
    private readonly servingIdentities = new WeakMap<ProviderRequestRoundAdmission, ServingMetricsIdentity>()
    private nextAuxiliaryApiIndex = 0

    constructor(private readonly options: TaskProviderRequestRoundOwnerOptions) {}

    admit(input: ProviderRequestRoundAdmissionInput): ProviderRequestRoundAdmission {
        const apiIndex = input.apiIndex ?? this.nextAuxiliaryApiIndex++
        const logicalRequestId = `${input.source}:${ulid()}`
        // Sampled once, at the real send. A Profile switch replaces the handler for the
        // next request, so reading this later would attribute these tokens to whichever
        // Profile the Task happened to run under when the batch was finally written.
        const servingIdentity = this.options.readServingIdentity?.()
        const admission: ProviderRequestRoundAdmission = {
            createAttemptObserver: (taskAttempt, _adapter) =>
                this.createAttemptObserver(admission, input, logicalRequestId, apiIndex, taskAttempt),
            attachExactUsage: (usage) => {
                const terminal = this.latestTerminals.get(admission)
                if (!terminal) return
                // The ApiHandler wrapper accumulates a send's usage and delivers it once when the stream closes.
                this.options.lifecycle.attachExactUsage(terminal, usage)
                this.options.lifecycle.finalizeTokens(terminal)
            },
            expectTools: () => this.options.lifecycle.expectTools(logicalRequestId),
            completeProviderOnly: () => this.options.lifecycle.completeProviderOnly(logicalRequestId),
            completeTools: (summary, toolCalls) => this.options.lifecycle.completeTools(logicalRequestId, summary, toolCalls),
            completeTurnEndAwaitingUser: (summary, toolCalls) =>
                this.options.lifecycle.completeTurnEndAwaitingUser(logicalRequestId, summary, toolCalls),
        }
        if (servingIdentity) this.servingIdentities.set(admission, servingIdentity)
        return admission
    }

    /** Observe one attempt of `admission`, keeping its latest terminal under that admission. */
    private createAttemptObserver(
        admission: ProviderRequestRoundAdmission,
        input: ProviderRequestRoundAdmissionInput,
        logicalRequestId: string,
        apiIndex: number,
        taskAttempt: number,
    ): ProviderAttemptObserver<ApiRequestRoundHandle> {
        const policyGeneration = this.options.readPolicyGeneration?.()
        const observer = this.options.lifecycle.createObserver({
            logicalRequestId,
            apiIndex,
            taskAttempt,
            role: input.source,
            ...(policyGeneration === undefined ? {} : { policyGeneration }),
        })
        return {
            beginAttempt: (identity) => observer.beginAttempt(this.projectIdentity(identity)),
            finishAttempt: async (handle, status, failure) => {
                await observer.finishAttempt(handle, status, failure)
                this.latestTerminals.set(admission, handle)
            },
        }
    }

    admitOrdinary(apiIndex: number, taskAttempt: number): ProviderRequestRoundAdmission {
        if (taskAttempt > 0) {
            const existing = this.ordinaryRounds.get(apiIndex)
            if (existing) return existing
        }
        const admission = this.admit({ source: "task", apiIndex })
        this.ordinaryRounds.set(apiIndex, admission)
        return admission
    }

    getOrdinary(apiIndex: number): ProviderRequestRoundAdmission | undefined {
        return this.ordinaryRounds.get(apiIndex)
    }

    /**
     * The attempt that last reached its terminal for one ordinary round.
     *
     * A consumer that reports the settled numbers of the round reads them through this
     * handle; the admission itself stays opaque so usage storage does not leak out.
     */
    settledRound(apiIndex: number): ApiRequestRoundHandle | undefined {
        const admission = this.ordinaryRounds.get(apiIndex)
        return admission === undefined ? undefined : this.latestTerminals.get(admission)
    }

    /** Who served the send admitted under `apiIndex`, frozen at its admission. */
    servingIdentityOf(apiIndex: number): ServingMetricsIdentity | undefined {
        const admission = this.ordinaryRounds.get(apiIndex)
        return admission === undefined ? undefined : this.servingIdentities.get(admission)
    }

    /**
     * Forget a settled round's frozen serving identity once its numbers are emitted.
     *
     * Called only when the send is fully finished: its usage, provider and execution
     * facts all read this identity, and the execution settles after the provider stream.
     */
    forgetServingIdentity(apiIndex: number): void {
        const admission = this.ordinaryRounds.get(apiIndex)
        if (admission === undefined) return
        this.servingIdentities.delete(admission)
        this.latestTerminals.delete(admission)
    }

    attachOrdinaryExactUsage(apiIndex: number, usage: ApiRequestRoundUsage): void {
        this.ordinaryRounds.get(apiIndex)?.attachExactUsage(usage)
    }

    /**
     * The attempt that last reached its terminal for one auxiliary admission.
     *
     * An auxiliary send settles through its own admission, whose terminal handle is
     * private to the admission closure. A consumer that re-expresses its numbers needs
     * the handle, not the admission, so this reads it back by the admission's api index.
     */
    settledAuxiliaryRound(admission: ProviderRequestRoundAdmission): ApiRequestRoundHandle | undefined {
        return this.latestTerminals.get(admission)
    }

    /** Who served an auxiliary send, frozen at its admission. */
    servingIdentityOfAdmission(admission: ProviderRequestRoundAdmission): ServingMetricsIdentity | undefined {
        return this.servingIdentities.get(admission)
    }

    /**
     * Who served the send that produced one logical execution.
     *
     * The execution settles at the tool or turn boundary, which is later than the
     * Provider stream. Reading the identity by admission keeps it correct for that
     * longer life instead of falling back to the Task's opening identity.
     */
    servingIdentityOfExecution(execution: { readonly roundId: string }): ServingMetricsIdentity | undefined {
        for (const admission of this.ordinaryRounds.values()) {
            if (this.latestTerminals.get(admission)?.roundId !== execution.roundId) continue
            return this.servingIdentities.get(admission)
        }
        return undefined
    }

    registerExecution(admission: ProviderRequestRoundAdmission, registration: ProviderExecutionRegistration): void {
        this.activeExecutions.set(admission, registration)
        for (const interaction of registration.turnEndInteractions) {
            this.turnEndExecutions.set(interaction.interactionId, {
                turnId: registration.turnId,
                blockId: interaction.blockId,
                toolCount: registration.toolCount,
                admission,
            })
        }
    }

    completeAtAwaitingUser(turnId: string, interactionId: string): void {
        const terminal = this.turnEndExecutions.get(interactionId)
        if (!terminal || terminal.turnId !== turnId || this.completedAdmissions.has(terminal.admission)) return
        const execution = this.activeExecutions.get(terminal.admission) ?? {
            turnId: terminal.turnId,
            toolCount: terminal.toolCount,
            turnEndInteractions: [],
        }
        this.completeWithTools(terminal.admission, execution, "turn_end_awaiting_user", terminal.blockId)
        this.clearExecution(terminal.admission, execution)
    }

    completeTurn(admission?: ProviderRequestRoundAdmission): void {
        if (!admission) return
        const execution = this.activeExecutions.get(admission)
        if (this.completedAdmissions.has(admission)) {
            if (execution) this.clearExecution(admission, execution)
            return
        }
        if (this.options.isExecutionCancelling()) {
            if (execution) this.clearExecution(admission, execution)
            return
        }
        if (!execution) {
            this.completedAdmissions.add(admission)
            admission.completeProviderOnly()
            return
        }
        this.completeWithTools(admission, execution, "tools_settled")
        this.clearExecution(admission, execution)
    }

    async waitForCompletions(): Promise<void> {
        while (this.pendingCompletions.size > 0) await Promise.allSettled([...this.pendingCompletions])
    }

    /** Freeze the contract model identity at admission; the raw wire model never leaves this boundary. */
    private projectIdentity(identity: ProviderAttemptIdentity | undefined): ProviderAttemptIdentity | undefined {
        if (!identity) return identity
        return { ...identity, modelId: projectUsageModelId(identity.modelId, { customModel: identity.customModel === true }) }
    }

    private clearExecution(admission: ProviderRequestRoundAdmission, execution: ActiveProviderExecution): void {
        for (const interaction of execution.turnEndInteractions) this.turnEndExecutions.delete(interaction.interactionId)
        this.activeExecutions.delete(admission)
    }

    private completeWithTools(
        admission: ProviderRequestRoundAdmission,
        execution: ActiveProviderExecution,
        terminalKind: "tools_settled" | "turn_end_awaiting_user",
        awaitingBlockId?: string,
    ): void {
        if (this.completedAdmissions.has(admission)) return
        this.completedAdmissions.add(admission)
        const blocks = [...this.options.readExecutionBlocks(execution.turnId)]
        const summary = this.summarizeExecutionTools(blocks, awaitingBlockId, execution.toolCount)
        const complete = (toolCalls?: readonly UsageToolCall[]) => {
            if (terminalKind === "turn_end_awaiting_user") {
                if (toolCalls) admission.completeTurnEndAwaitingUser(summary, toolCalls)
                else admission.completeTurnEndAwaitingUser(summary)
            } else if (toolCalls) admission.completeTools(summary, toolCalls)
            else admission.completeTools(summary)
        }
        const resolver = this.options.resolveExecutionToolCalls
        if (!resolver || blocks.length === 0) {
            complete()
            return
        }
        const pending = resolver(blocks, awaitingBlockId)
            .then(
                (toolCalls) => complete(toolCalls.length === summary.toolCount ? toolCalls : undefined),
                (error) => {
                    Logger.debug(`[usage] logical execution tool names could not be resolved: ${String(error)}`)
                    complete()
                },
            )
            .catch((error) => Logger.debug(`[usage] logical execution could not be finalized: ${String(error)}`))
            .finally(() => this.pendingCompletions.delete(pending))
        this.pendingCompletions.add(pending)
    }

    private summarizeExecutionTools(
        blocks: readonly ProviderExecutionBlock[],
        awaitingBlockId?: string,
        fallbackToolCount = 0,
    ): ApiResponseExecutionToolSummary {
        let completedToolCount = 0
        let failedToolCount = 0
        let cancelledToolCount = 0
        for (const block of blocks) {
            if (block.blockId === awaitingBlockId || block.phase === "completed") {
                completedToolCount += 1
                continue
            }
            if (block.phase === "failed" || block.phase === "rejected") {
                failedToolCount += 1
                continue
            }
            if (isUnsettledOrCancelled(block.phase)) {
                cancelledToolCount += 1
            }
        }
        if (blocks.length === 0 && fallbackToolCount > 0) {
            const fallbackCompletedToolCount = awaitingBlockId ? 1 : 0
            return {
                toolCount: fallbackToolCount,
                completedToolCount: fallbackCompletedToolCount,
                failedToolCount: 0,
                cancelledToolCount: fallbackToolCount - fallbackCompletedToolCount,
            }
        }
        const toolCount = completedToolCount + failedToolCount + cancelledToolCount
        return { toolCount, completedToolCount, failedToolCount, cancelledToolCount }
    }
}

function isUnsettledOrCancelled(phase: BlockPhase): boolean {
    return (
        phase === "pending" ||
        phase === "awaiting_approval" ||
        phase === "ready" ||
        phase === "executing" ||
        phase === "skipped" ||
        phase === "cancelled"
    )
}
