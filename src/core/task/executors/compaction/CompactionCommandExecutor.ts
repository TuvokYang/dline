import { Logger } from "@shared/services/Logger"
import type { Command, CompactionRunCommand } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"

export interface CompactionExecutionInput {
    readonly compactionId: string
    readonly attempt: string
    readonly contextRef: string
    readonly signal: AbortSignal
    readonly publish: (projection: Readonly<Record<string, unknown>>) => void
}

export interface CompactionExecutionResult {
    readonly resultRef: string
    /** The durable completed presentation exists, so a later cancel cannot reclassify this run. */
    readonly completionCommitted?: boolean
}

export interface CompactionPort {
    run(input: CompactionExecutionInput): Promise<CompactionExecutionResult>
}

/**
 * A run that failed for a reason its port already told the user.
 *
 * A provider refusing a Pass, or a conversation with no complete turn, is an
 * expected outcome rather than a fault in the executor, so it is recorded as a
 * warning instead of an error. The message is the reason the user was shown.
 */
export class CompactionRunFailedError extends Error {
    constructor(message: string, options?: { readonly cause?: unknown }) {
        super(message, options)
        this.name = "CompactionRunFailed"
    }
}

/** Report one failed run, at the severity its cause deserves. */
function runFailure(error: unknown): string {
    if (!(error instanceof CompactionRunFailedError)) return executorFailure("compaction", error)
    const failure = `compaction execution failed (${error.name})`
    Logger.warn(`${failure}: ${error.message}`)
    return failure
}

interface ActiveCompaction {
    readonly attempt: string
    readonly controller: AbortController
    completion: Promise<void>
}

export class CompactionCommandExecutor implements CommandExecutor, HaltParticipant {
    readonly domain = "compaction" as const
    readonly id = "compaction" as const
    private readonly active = new Map<string, ActiveCompaction>()
    private fencedHaltId: string | undefined

    constructor(
        private readonly port: CompactionPort,
        private readonly events: TaskEventSink,
        private readonly publish: (projection: Readonly<Record<string, unknown>>) => void = () => undefined,
    ) {}

    execute(command: Command): Promise<void> {
        if (command.type !== "compaction.run") return Promise.reject(new Error(`Compaction executor cannot run ${command.type}`))
        if (this.fencedHaltId) return Promise.resolve()
        if (this.active.size > 0) return Promise.reject(new Error("Compaction execution is already active"))

        const active: ActiveCompaction = {
            attempt: command.attempt,
            controller: new AbortController(),
            completion: Promise.resolve(),
        }
        active.completion = this.run(command, active).finally(() => this.active.delete(command.compactionId))
        this.active.set(command.compactionId, active)
        return active.completion
    }

    fence(order: HaltOrder): void {
        this.fencedHaltId = order.haltId
    }

    stop(order: HaltOrder): void {
        this.cancelAll(`compaction_${order.reason}`)
    }

    async drain(_order: HaltOrder): Promise<void> {
        await Promise.allSettled([...this.active.values()].map((active) => active.completion))
    }

    rearm(haltId: string): void {
        if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
    }

    cancel(compactionId: string, reason = "compaction_cancelled"): boolean {
        const active = this.active.get(compactionId)
        if (!active) return false
        active.controller.abort(reason)
        return true
    }

    cancelAll(reason = "compaction_cancelled"): number {
        for (const active of this.active.values()) active.controller.abort(reason)
        return this.active.size
    }

    private async run(command: CompactionRunCommand, active: ActiveCompaction): Promise<void> {
        const started = await this.events.submit({
            type: "compaction.started",
            generation: command.generation,
            compactionId: command.compactionId,
            attempt: command.attempt,
        })
        if (started.kind === "rejected") return
        if (active.controller.signal.aborted) {
            await this.expire(command, "compaction_cancelled")
            return
        }

        let result: CompactionExecutionResult
        try {
            result = await this.port.run({
                compactionId: command.compactionId,
                attempt: command.attempt,
                contextRef: command.contextRef,
                signal: active.controller.signal,
                publish: (projection) => {
                    if (this.isCurrent(command, active) && !active.controller.signal.aborted) this.publish(projection)
                },
            })
        } catch (error) {
            if (isExecutionAbort(error, active.controller.signal)) await this.expire(command, "compaction_cancelled")
            else
                await this.events.submit({
                    type: "compaction.failed",
                    generation: command.generation,
                    compactionId: command.compactionId,
                    attempt: command.attempt,
                    message: runFailure(error),
                })
            return
        }
        if (active.controller.signal.aborted && result.completionCommitted !== true) {
            await this.expire(command, "compaction_cancelled")
            return
        }
        if (!result.resultRef) {
            await this.events.submit({
                type: "compaction.failed",
                generation: command.generation,
                compactionId: command.compactionId,
                attempt: command.attempt,
                message: "compaction execution failed (MissingCompactionResult)",
            })
            return
        }
        await this.events.submit({
            type: "compaction.completed",
            generation: command.generation,
            compactionId: command.compactionId,
            attempt: command.attempt,
            resultRef: result.resultRef,
            ...(result.completionCommitted === true ? { completionCommitted: true } : {}),
        })
    }

    private isCurrent(command: CompactionRunCommand, active: ActiveCompaction): boolean {
        return this.active.get(command.compactionId) === active && active.attempt === command.attempt && !this.fencedHaltId
    }

    private expire(command: CompactionRunCommand, message: string): Promise<unknown> {
        return this.events.submit({
            type: "compaction.expired",
            generation: command.generation,
            compactionId: command.compactionId,
            attempt: command.attempt,
            message,
        })
    }
}
