import { type DialogInteraction, dueAwayInteraction, type TaskEvent, type TaskState } from "../kernel"

export interface TaskDeadlineClock {
    now(): number
    schedule(callback: () => void, delayMs: number): unknown
    cancel(handle: unknown): void
}

export const systemTaskDeadlineClock: TaskDeadlineClock = {
    now: () => Date.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Exactly one wakeup per runtime. Eligibility and outcomes remain in the kernel. */
export class TaskDeadlineScheduler {
    private timer: unknown
    private closed = false
    private pending: Promise<void> = Promise.resolve()

    constructor(
        private readonly readState: () => Readonly<TaskState>,
        private readonly submit: (event: TaskEvent) => Promise<unknown>,
        private readonly permitted: () => boolean,
        private readonly reportError: (error: unknown) => void,
        private readonly clock: TaskDeadlineClock = systemTaskDeadlineClock,
    ) {}

    refresh(): void {
        this.clear()
        if (this.closed || !this.permitted()) return
        const state = this.readState()
        if (state.halt.status !== "idle" || !["running", "waiting"].includes(state.flow.phase)) return
        const candidates = [state.dialog.primary, ...Object.values(state.dialog.approvalsByBlock)]
            .filter((interaction): interaction is DialogInteraction => interaction?.deadline !== undefined)
            .filter((interaction) => dueAwayInteraction(state, this.event(state, interaction, interaction.deadline!.deadlineAt)))
            .sort((a, b) => a.deadline!.deadlineAt - b.deadline!.deadlineAt)
        const first = candidates[0]
        if (!first) return
        this.timer = this.clock.schedule(
            () => {
                this.timer = undefined
                if (this.closed || !this.permitted()) return
                this.pending = this.deliver(first).catch(this.reportError)
            },
            Math.max(0, first.deadline!.deadlineAt - this.clock.now()),
        )
    }

    beginClose(): void {
        this.closed = true
        this.clear()
    }
    async dispose(): Promise<void> {
        this.beginClose()
        await this.pending
    }

    private async deliver(interaction: DialogInteraction): Promise<void> {
        const state = this.readState()
        await this.submit(this.event(state, interaction, this.clock.now()))
        this.refresh()
    }

    private event(
        state: TaskState,
        interaction: DialogInteraction,
        now: number,
    ): Extract<TaskEvent, { type: "away.deadline_due" }> {
        return {
            type: "away.deadline_due",
            generation: state.generation,
            interactionId: interaction.interactionId,
            turnId: interaction.turnId,
            receiverGeneration: interaction.receiverGeneration ?? -1,
            deadlineAt: interaction.deadline!.deadlineAt,
            now,
        }
    }

    private clear(): void {
        if (this.timer !== undefined) this.clock.cancel(this.timer)
        this.timer = undefined
    }
}
