import type { TaskEvent, TaskState } from "../kernel"
import type { ToolPostCommitDirective } from "../tools/ToolExecutionResult"
import { createNewTaskHandoff, type NewTaskHandoff, type NewTaskSettingsSource } from "./new-task-handoff"

/**
 * Starts the task a `new_task` block handed its work to.
 *
 * The host owns task lifetimes, so starting the successor, and replacing the
 * source on its surface, is its decision; the runtime only says when.
 */
export interface TaskSuccessorPort {
    /** Task-local bindings the successor inherits, read when the handoff happens. */
    settings(): NewTaskSettingsSource
    /**
     * Start the successor.
     *
     * Called only after the source is durably consumed, and never from inside the
     * tool block: starting a successor tears the source down, and that teardown
     * waits for the very block that asked for it.
     */
    start(handoff: NewTaskHandoff): Promise<void>
    /** Reports a successor that failed to start; the source stays consumed. */
    onError?(error: unknown): void
}

/** The part of the task runtime a handoff needs. */
export interface SuccessorHandoffRuntime {
    getState(): Readonly<TaskState>
    submit(event: TaskEvent): Promise<{ readonly kind: "accepted" | "rejected"; readonly state: TaskState }>
    waitForDurable(revision: number): Promise<void>
}

export interface SuccessorHandoffPublisherOptions {
    /** Late-bound because the adapter is composed before the runtime exists. */
    readonly runtime: () => SuccessorHandoffRuntime | undefined
    readonly successor: TaskSuccessorPort
    /** Defers the start past the tool block; tests substitute a synchronous one. */
    readonly schedule?: (run: () => void) => void
}

/** One directive to carry out, and what the source must record once it is consumed. */
export interface SuccessorHandoffRequest {
    readonly command: SuccessorHandoffCommand
    readonly directive: ToolPostCommitDirective
    /**
     * Runs after the source is durably consumed and before the successor is
     * scheduled, so it never races the teardown the successor's start causes.
     *
     * A restored approval writes the call's result here rather than before the
     * handoff: a refused handoff then leaves nothing claiming a successor was
     * created. Must not throw; the successor starts whether or not it succeeds.
     */
    readonly beforeStart?: () => Promise<void>
}

export interface SuccessorHandoffCommand {
    readonly turnId?: string
    readonly dlineTid: string
    /** The directive answers a dialog restored after its block's process ended; see the `lifecycle.consumed` event. */
    readonly restoredDialog?: true
}

/**
 * What became of a directive.
 *
 * `refused` means the kernel would not let the block hand off, so no successor
 * starts and the source stays as it was; a caller that answered on the user's
 * behalf has to keep the dialog answerable rather than report success.
 */
export type SuccessorHandoffOutcome = "handed_off" | "refused" | "not_a_handoff"

/**
 * Carries out what a tool result commits its task to.
 *
 * One port for every caller: the live tool adapter and a restored dialog both
 * record the block's result through `beforeStart`, so the result exists only
 * once the directive was accepted, and both learn whether it was.
 */
export type PostCommitPublisher = (request: SuccessorHandoffRequest) => Promise<SuccessorHandoffOutcome>

/** The identity a consumed source keeps of the handoff that consumed it. */
export function newTaskConsumedRef(directive: { readonly functionId: string; readonly dlineTid: string }): string {
    return `new_task:${directive.functionId}:${directive.dlineTid}`
}

const deferPastTheBlock = (run: () => void) => {
    setTimeout(run, 0)
}

/**
 * Carry out a `start_successor_task` directive.
 *
 * The source is marked consumed while its block is still running, so the
 * block's own completion is refused and cannot open another round for a
 * conversation the successor now owns. A handoff the kernel refuses, because
 * the task is already stopping, starts nothing: the user stopped it first.
 */
export function createSuccessorHandoffPublisher(options: SuccessorHandoffPublisherOptions): PostCommitPublisher {
    const schedule = options.schedule ?? deferPastTheBlock
    return async ({ command, directive, beforeStart }) => {
        if (directive.type !== "start_successor_task") return "not_a_handoff"
        const runtime = options.runtime()
        if (!runtime || !command.turnId) throw new Error("NewTaskHandoffWithoutActiveTurn")
        const consumed = await runtime.submit({
            type: "lifecycle.consumed",
            generation: runtime.getState().generation,
            turnId: command.turnId,
            blockId: command.dlineTid,
            consumedRef: newTaskConsumedRef(directive),
            ...(command.restoredDialog ? { restoredDialog: true as const } : {}),
        })
        if (consumed.kind === "rejected") return "refused"
        // A successor must never exist beside a source that could still resume.
        await runtime.waitForDurable(consumed.state.revision)
        await beforeStart?.()
        const handoff = createNewTaskHandoff(directive, options.successor.settings())
        schedule(() => {
            void options.successor.start(handoff).catch((error) => options.successor.onError?.(error))
        })
        return "handed_off"
    }
}
