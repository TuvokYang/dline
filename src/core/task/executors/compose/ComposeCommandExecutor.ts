import { Logger } from "@shared/services/Logger"
import type {
    Command,
    ComposeRoundCommand,
    InputQueueDeliveryReservation,
    QueuedInputResponse,
    QueueJournalReceipt,
    ToolTerminalManifest,
    TurnContinuationReason,
} from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import {
    describeExecutorFailure,
    executorFailure,
    type HaltOrder,
    type HaltParticipant,
    isExecutionAbort,
    type TaskEventSink,
} from "../contracts"
import type { RetainedInputPresentationCommit } from "./RetainedInputPresentationPort"

export interface ComposeRoundInput {
    readonly turnId?: string
    readonly admittedEntryIds: readonly string[]
    readonly queueDelivery?: InputQueueDeliveryReservation
    readonly respondedQueue?: QueuedInputResponse
    readonly toolTerminals?: ToolTerminalManifest
    /**
     * Why the kernel opened this round without a submission, when it did.
     *
     * The compose domain owns what a round contains, so the reason has to reach
     * it: a round continued after a toolless answer must tell the model why it
     * is being asked again, or the same answer simply repeats.
     */
    readonly continuation?: TurnContinuationReason
    readonly signal: AbortSignal
}

/**
 * What composing one round produced.
 *
 * Either a draft for the provider, or the round given up before any draft:
 * a lifecycle command the round had to carry out first did not complete, so
 * nothing the user still wants remains to be sent. `withdrawn` is the user's
 * own decision; `failed` is work the round owed that failed, which the user
 * is offered to retry, and whose domain already explained it.
 */
export type ComposeRoundResult =
    | { readonly draftRef: string; readonly queueJournalReceipt?: QueueJournalReceipt }
    | { readonly withdrawn: { readonly reason: string; readonly carriedOut?: boolean } }
    | { readonly failed: { readonly reason: string; readonly presentation?: string } }

export interface ComposePort {
    compose(input: ComposeRoundInput): Promise<ComposeRoundResult>
    /** Reserves row order before composing; publishing waits for accepted feedback. */
    preparePresentation?(input: ComposeRoundInput): Promise<RetainedInputPresentationCommit | undefined>
    /** Retracts any staged retained batch without deciding its kernel lifecycle. */
    rollbackRetainedQueue?(input: ComposeRoundInput): Promise<"released" | "uncertain">
}

interface ActiveComposeCommand {
    readonly controller: AbortController
    readonly completion: Promise<void>
}

export class ComposeCommandExecutor implements CommandExecutor, HaltParticipant {
    readonly domain = "compose" as const
    readonly id = "compose" as const
    private readonly active = new Map<string, ActiveComposeCommand>()
    private fencedHaltId: string | undefined

    constructor(
        private readonly port: ComposePort,
        private readonly events: TaskEventSink,
    ) {}

    execute(command: Command): Promise<void> {
        if (command.type !== "compose.round") return Promise.reject(new Error(`Compose executor cannot run ${command.type}`))
        if (this.fencedHaltId) return Promise.resolve()
        if (this.active.size > 0) return Promise.reject(new Error("Compose execution is already active"))
        const controller = new AbortController()
        const completion = this.run(command, controller).finally(() => this.active.delete(command.commandId))
        this.active.set(command.commandId, { controller, completion })
        return completion
    }

    fence(order: HaltOrder): void {
        this.fencedHaltId = order.haltId
    }

    stop(order: HaltOrder): void {
        this.cancelAll(`compose_${order.reason}`)
    }

    async drain(_order: HaltOrder): Promise<void> {
        await Promise.allSettled([...this.active.values()].map((active) => active.completion))
    }

    rearm(haltId: string): void {
        if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
    }

    cancel(commandId: string, reason = "compose_cancelled"): boolean {
        const active = this.active.get(commandId)
        if (!active) return false
        active.controller.abort(reason)
        return true
    }

    cancelAll(reason = "compose_cancelled"): number {
        for (const active of this.active.values()) active.controller.abort(reason)
        return this.active.size
    }

    private async run(command: ComposeRoundCommand, controller: AbortController): Promise<void> {
        const input: ComposeRoundInput = {
            turnId: command.turnId,
            admittedEntryIds: command.admittedEntryIds,
            ...(command.queueDelivery === undefined ? {} : { queueDelivery: command.queueDelivery }),
            ...(command.respondedQueue === undefined ? {} : { respondedQueue: command.respondedQueue }),
            ...(command.toolTerminals === undefined ? {} : { toolTerminals: command.toolTerminals }),
            ...(command.continuation === undefined ? {} : { continuation: command.continuation }),
            signal: controller.signal,
        }
        let result: ComposeRoundResult
        let presentation: RetainedInputPresentationCommit | undefined
        try {
            presentation = await this.port.preparePresentation?.(input)
            result = await this.port.compose(input)
        } catch (error) {
            if (isExecutionAbort(error, controller.signal)) return
            const queueDisposition = await this.rollbackRetainedQueue(input)
            await this.events.submit({
                type: "compose.failed",
                generation: command.generation,
                commandId: command.commandId,
                originRevision: command.originRevision,
                turnId: command.turnId,
                message: executorFailure("compose", error),
                presentation: describeExecutorFailure("compose", error),
                ...(queueDisposition === undefined ? {} : { queueDisposition }),
            })
            return
        }
        if (controller.signal.aborted) return
        if ("failed" in result) {
            // An expected outcome its own domain presented, not an executor fault.
            Logger.warn(`[compose] Round stopped before drafting: ${result.failed.reason}`)
            const queueDisposition = await this.rollbackRetainedQueue(input)
            await this.events.submit({
                type: "compose.failed",
                generation: command.generation,
                commandId: command.commandId,
                originRevision: command.originRevision,
                turnId: command.turnId,
                message: result.failed.reason,
                ...(result.failed.presentation === undefined ? {} : { presentation: result.failed.presentation }),
                ...(queueDisposition === undefined ? {} : { queueDisposition }),
            })
            return
        }
        if ("withdrawn" in result) {
            await this.events.submit({
                type: "compose.withdrawn",
                generation: command.generation,
                commandId: command.commandId,
                originRevision: command.originRevision,
                turnId: command.turnId,
                reason: result.withdrawn.reason,
                ...(result.withdrawn.carriedOut ? { carriedOut: true } : {}),
            })
            return
        }
        if (!result.draftRef) throw new Error("MissingDraftRef")
        const completed = await this.events.submit(this.completed(command, result))
        if (completed.kind === "rejected") {
            const queueDisposition = await this.rollbackRetainedQueue(input)
            if (queueDisposition !== undefined) {
                await this.events.submit({
                    type: "compose.withdrawn",
                    generation: command.generation,
                    commandId: command.commandId,
                    originRevision: command.originRevision,
                    turnId: command.turnId,
                    reason: "compose_completion_rejected",
                    queueDisposition,
                })
            }
            return
        }
        await completed.durable
        try {
            await presentation?.commit()
        } catch (error) {
            // A durable draft must not be resent because its chat mirror failed.
            Logger.error("[inputQueue] Could not present a composed retained-input batch", error)
        }
    }

    private async rollbackRetainedQueue(input: ComposeRoundInput): Promise<"released" | "uncertain" | undefined> {
        if (!input.queueDelivery) return undefined
        if (!this.port.rollbackRetainedQueue) return "uncertain"
        try {
            return await this.port.rollbackRetainedQueue(input)
        } catch (error) {
            Logger.error("[inputQueue] Could not retract a failed retained-input batch", error)
            return "uncertain"
        }
    }

    private completed(command: ComposeRoundCommand, result: Extract<ComposeRoundResult, { readonly draftRef: string }>) {
        return {
            type: "compose.completed" as const,
            generation: command.generation,
            commandId: command.commandId,
            originRevision: command.originRevision,
            turnId: command.turnId,
            draftRef: result.draftRef,
            ...(result.queueJournalReceipt === undefined ? {} : { queueJournalReceipt: result.queueJournalReceipt }),
        }
    }
}
