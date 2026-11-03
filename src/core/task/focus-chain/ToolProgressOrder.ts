import { Logger } from "@shared/services/Logger"
import type { KernelBlock, TaskState } from "../kernel"

interface ProgressSlot {
    readonly blockId: string
    readonly attempt: KernelBlock["attempt"]
    readonly done: Promise<void>
    resolve(): void
    ready: boolean
    commit?: () => Promise<void>
}

interface ProgressTurn {
    readonly turnId: string
    readonly generation: number
    readonly slots: ProgressSlot[]
    cursor: number
    cancelled: boolean
    draining?: Promise<void>
}

const terminal = new Set<KernelBlock["phase"]>(["completed", "failed", "rejected", "skipped", "cancelled"])

/** Orders only short progress commits. It never holds a tool permit waiting for an unready predecessor. */
export class ToolProgressOrder {
    private turn?: ProgressTurn

    constructor(private readonly readState: () => Readonly<TaskState>) {}

    bind(turnId: string, blockId: string): (commit: () => Promise<void>, wait: boolean) => Promise<void> {
        this.synchronize(this.readState())
        const turn = this.turn
        const slot = turn?.turnId === turnId ? turn.slots.find((entry) => entry.blockId === blockId) : undefined
        if (!slot) Logger.warn(`[ToolProgressOrder] Missing progress slot for ${turnId}/${blockId}`)
        return async (commit, wait) => {
            if (!turn || !slot || turn.cancelled || this.turn !== turn) return
            if (!slot.ready) {
                slot.commit = commit
                slot.ready = true
            }
            this.drain(turn)
            // Waiting while a lower block is still executing/awaiting approval
            // could fill the pool and prevent that very block from starting.
            const index = turn.slots.indexOf(slot)
            if (wait || turn.slots.slice(turn.cursor, index).every((entry) => entry.ready)) await slot.done
        }
    }

    /** TURN-END gates must inspect all earlier accepted progress, not just earlier tool results. */
    async settleBefore(turnId: string, blockId: string): Promise<void> {
        this.synchronize(this.readState())
        const turn = this.turn
        if (!turn || turn.turnId !== turnId || turn.cancelled) return
        const index = turn.slots.findIndex((slot) => slot.blockId === blockId)
        if (index < 0) return
        this.drain(turn)
        await Promise.all(turn.slots.slice(0, index).map((slot) => slot.done))
    }

    /** Kernel terminal facts close holes left by refusal, failure, or calls that never reached a handler. */
    synchronize(state: Readonly<TaskState>): void {
        if (this.turn && this.turn.generation !== state.generation) this.cancel()
        const turnId = state.turn.turnId
        // Compose/provider startup can publish the turn identity before its final
        // block manifest exists. Do not freeze an empty scope for that identity.
        if (!turnId || state.turn.blocks.length === 0) return
        if (this.turn?.turnId !== turnId) {
            this.cancel()
            this.turn = {
                turnId,
                generation: state.generation,
                cursor: 0,
                cancelled: false,
                slots: [...state.turn.blocks]
                    .sort((a, b) => a.index - b.index)
                    .map((block) => {
                        let resolve!: () => void
                        const done = new Promise<void>((settled) => {
                            resolve = settled
                        })
                        return { blockId: block.blockId, attempt: block.attempt, done, resolve, ready: false }
                    }),
            }
        }
        const turn = this.turn
        if (!turn || turn.cancelled) return
        for (const block of state.turn.blocks) {
            const slot = turn.slots.find((entry) => entry.blockId === block.blockId && entry.attempt === block.attempt)
            if (slot && !slot.ready && terminal.has(block.phase)) slot.ready = true
        }
        this.drain(turn)
    }

    /** Called only at the next-round boundary, after the previous turn's tools have settled. */
    async flush(): Promise<void> {
        this.synchronize(this.readState())
        const turn = this.turn
        if (!turn || turn.cancelled) return
        // A compose boundary can clear the previous turn before view notification.
        // Any unreported terminal call is a no-op, never a replay of its parameters.
        for (const slot of turn.slots) if (!slot.ready) slot.ready = true
        this.drain(turn)
        await Promise.all(turn.slots.map((slot) => slot.done))
    }

    /** A halt releases waiters immediately and fences every late callback captured by the old scope. */
    cancel(): void {
        if (!this.turn) return
        const pending = this.turn.slots.slice(this.turn.cursor).filter((slot) => slot.commit !== undefined).length
        if (pending > 0)
            Logger.debug(
                `[ToolProgressOrder] Discarding ${pending} uncommitted progress reports from retired turn ${this.turn.turnId}`,
            )
        this.turn.cancelled = true
        for (const slot of this.turn.slots) slot.resolve()
        this.turn = undefined
    }

    private drain(turn: ProgressTurn): void {
        if (turn.draining || turn.cancelled) return
        turn.draining = (async () => {
            while (!turn.cancelled && turn.slots[turn.cursor]?.ready) {
                const slot = turn.slots[turn.cursor++]
                try {
                    await slot.commit?.()
                } catch (error) {
                    Logger.error("Ordered task progress commit failed", error)
                } finally {
                    slot.resolve()
                }
            }
        })().finally(() => {
            turn.draining = undefined
            if (!turn.cancelled && turn.slots[turn.cursor]?.ready) this.drain(turn)
        })
    }
}
