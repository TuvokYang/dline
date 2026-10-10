import { isDenied, type ToolDomainSurface } from "./ToolDomainSurface"

/**
 * The tool execution domain.
 *
 * It follows the WS-051 executor contract: `handle` returns immediately, work
 * proceeds asynchronously, and every outcome reaches the runtime as an event.
 * The domain never inspects kernel state and never calls another executor, so
 * the scheduling decision must arrive inside the command.
 */

/** One block the reducer has admitted for execution. */
export interface ToolRunCommand {
    readonly commandId: string
    readonly turnId?: string
    readonly dlineTid: string
    readonly invocationRef: string
    /** Resolved by the reducer; the domain does not re-derive it. */
    readonly mode?: "serial" | "parallel"
}

/** Generation marker for one stop request. */
export type HaltId = string

export interface HaltOrder {
    readonly haltId: HaltId
    readonly reason: "cancel" | "terminate" | "detach"
}

export type ToolDomainEvent =
    | { kind: "tool.block_result"; commandId: string; turnId?: string; dlineTid: string }
    | {
          kind: "tool.block_failed"
          commandId: string
          turnId?: string
          dlineTid: string
          message: string
          /** The original failure, so error identity and stack survive the hop. */
          cause?: unknown
      }
    | { kind: "tool.rejected"; commandId: string; dlineTid: string; reason: "halted" | "superseded" }
    | { kind: "tool.halted"; haltId: HaltId }

export interface ToolDomainEventSink {
    emit(event: ToolDomainEvent): void
}

/** The side-effecting work the domain owns; injected so the domain stays testable. */
export interface ToolDomainRunner {
    runBlock(command: ToolRunCommand): Promise<void>
    /** Request cancellation before the domain waits for in-flight work to settle. */
    requestStop?(order: HaltOrder): Promise<void>
    /** Release remaining owned resources exactly once after the drain. */
    release(order: HaltOrder): Promise<void>
}

export interface ToolExecutionDomainOptions {
    readonly runner: ToolDomainRunner
    readonly sink: ToolDomainEventSink
    readonly surface: ToolDomainSurface
    /** Stable identity used to mint stop generations. */
    readonly identityPrefix?: string
    /** Maximum time the caller waits for one stop generation to drain. */
    readonly haltBudgetMs?: number
    /** Release waiters when a drain cannot produce its normal receipt. */
    readonly releaseFallback?: () => void
    /** Report a bounded halt failure without coupling the domain to a logger. */
    readonly onHaltFailure?: (error: unknown) => void
}

export class ToolExecutionDomain {
    readonly domain = "tool" as const

    private readonly runner: ToolDomainRunner
    private readonly sink: ToolDomainEventSink
    private readonly surface: ToolDomainSurface
    private readonly identityPrefix: string
    private readonly haltBudgetMs: number
    private readonly releaseFallback: () => void
    private readonly onHaltFailure: (error: unknown) => void
    private toolHaltSequence = 0

    /** In-flight work, keyed by commandId so a late result can be attributed. */
    private readonly inFlight = new Map<string, Promise<void>>()

    /**
     * The current stop generation. Once set, commands are refused and results
     * from before the stop are dropped, which is what makes `tool.halted` a
     * drain barrier rather than a hint.
     */
    private haltGeneration: HaltId | undefined
    private haltOperation: { readonly haltId: HaltId; readonly completion: Promise<void> } | undefined

    constructor(options: ToolExecutionDomainOptions) {
        this.runner = options.runner
        this.sink = options.sink
        this.surface = options.surface
        this.identityPrefix = options.identityPrefix ?? "tool-domain"
        this.haltBudgetMs = options.haltBudgetMs ?? 5_000
        this.releaseFallback = options.releaseFallback ?? (() => undefined)
        this.onHaltFailure = options.onHaltFailure ?? (() => undefined)
    }

    /** True when this assembly cannot reach a user at all. */
    get isHeadless(): boolean {
        return isDenied(this.surface)
    }

    /**
     * Accept one tool command.
     *
     * Returns immediately by contract: the caller is the serialized runtime
     * dispatch path, and awaiting a tool here would block every later event.
     */
    handle(command: ToolRunCommand): void {
        if (this.haltGeneration !== undefined) {
            this.sink.emit({ kind: "tool.rejected", commandId: command.commandId, dlineTid: command.dlineTid, reason: "halted" })
            return
        }

        const generationAtStart = this.haltGeneration
        const work = this.runner
            .runBlock(command)
            .then(() => {
                // A result produced before a stop must not resurrect the turn.
                if (this.haltGeneration !== generationAtStart) {
                    return
                }
                this.sink.emit({
                    kind: "tool.block_result",
                    commandId: command.commandId,
                    turnId: command.turnId,
                    dlineTid: command.dlineTid,
                })
            })
            .catch((error: unknown) => {
                if (this.haltGeneration !== generationAtStart) {
                    return
                }
                // A failure is a result with error content, not an escape hatch:
                // it must reach the runtime as an event like any other outcome.
                this.sink.emit({
                    kind: "tool.block_failed",
                    commandId: command.commandId,
                    turnId: command.turnId,
                    dlineTid: command.dlineTid,
                    message: error instanceof Error ? error.message : String(error),
                    cause: error,
                })
            })
            .finally(() => {
                this.inFlight.delete(command.commandId)
            })

        this.inFlight.set(command.commandId, work)
    }

    /**
     * Stop the domain and report when it is quiet.
     *
     * The receipt is emitted only after in-flight work has settled and owned
     * resources have been released, so the runtime can treat `tool.halted` as
     * proof that nothing further will arrive from this domain.
     */
    halt(order: HaltOrder): Promise<void> {
        const existing = this.haltOperation
        if (existing?.haltId === order.haltId) return existing.completion
        this.fence(order.haltId)
        const previous = existing?.completion.catch(() => undefined) ?? Promise.resolve()
        const completion = previous.then(() => this.drainHalt(order))
        this.haltOperation = { haltId: order.haltId, completion }
        return completion
    }

    private async drainHalt(order: HaltOrder): Promise<void> {
        const pending = [...this.inFlight.entries()]
        const stop = this.runner.requestStop ? await Promise.allSettled([this.runner.requestStop(order)]) : []
        await Promise.allSettled(pending.map(([, work]) => work))
        try {
            await this.runner.release(order)
            if (stop[0]?.status === "rejected") throw stop[0].reason
        } finally {
            for (const [commandId, work] of pending) {
                if (this.inFlight.get(commandId) === work) this.inFlight.delete(commandId)
            }
            if (this.haltGeneration === order.haltId) this.sink.emit({ kind: "tool.halted", haltId: order.haltId })
        }
    }

    /**
     * Stop the domain under its own generation, budget and fallback policy.
     *
     * The caller names only why it is stopping. The domain owns every detail
     * needed to make the stop bounded and to release correlated waiters when a
     * stuck effect cannot produce the ordinary drain receipt.
     */
    async haltToolDomain(reason: HaltOrder["reason"]): Promise<void> {
        this.toolHaltSequence += 1
        const haltId = `${this.identityPrefix}:halt:${this.toolHaltSequence}`
        let timeout: ReturnType<typeof setTimeout> | undefined
        let drained = false
        try {
            drained = await Promise.race([
                this.halt({ haltId, reason }).then(() => true),
                new Promise<false>((resolve) => {
                    timeout = setTimeout(() => resolve(false), this.haltBudgetMs)
                }),
            ])
            if (!drained) {
                const error = new Error(`Tool domain halt timed out after ${this.haltBudgetMs}ms`)
                this.onHaltFailure(error)
                this.releaseFallback()
            }
        } catch (error) {
            this.onHaltFailure(error)
            this.releaseFallback()
        } finally {
            if (timeout) clearTimeout(timeout)
            // A timed-out generation remains fenced until its real drain completes.
            if (drained) this.rearm(haltId)
        }
    }

    /** Establish the stop fence synchronously before orchestration awaits another participant. */
    fence(haltId: HaltId): void {
        this.haltGeneration = haltId
    }

    /**
     * Re-admit work after a stop, once the runtime starts a new generation.
     *
     * The caller names the stop it is retiring. A later stop that arrived while
     * this one was draining must stay in force, otherwise the newer barrier
     * would be lifted by the older caller and admit work it intended to refuse.
     */
    rearm(haltId?: HaltId): void {
        if (haltId !== undefined && this.haltGeneration !== haltId) {
            return
        }
        this.haltGeneration = undefined
        if (haltId === undefined || this.haltOperation?.haltId === haltId) this.haltOperation = undefined
    }

    get inFlightCount(): number {
        return this.inFlight.size
    }
}
