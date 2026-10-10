import type { ClineUserContent } from "@shared/messages/content"
import type { TaskEvent, TaskState } from "../kernel"
import type { ToolPostCommitDirective } from "../tools/ToolExecutionResult"
import {
    createNewTaskHandoff,
    type NewTaskConsumedState,
    type NewTaskHandoff,
    type NewTaskSettingsSource,
} from "./new-task-handoff"

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
     * Feedback the user gave on an earlier proposal of this handoff, as the
     * successor's first input. Absent, the successor starts from its context alone.
     */
    feedback?(source: NewTaskConsumedState): Promise<readonly ClineUserContent[]>
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

export interface SuccessorHandoffCommand {
    readonly turnId?: string
    readonly dlineTid: string
}

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
export function createSuccessorHandoffPublisher(
    options: SuccessorHandoffPublisherOptions,
): (input: { readonly command: SuccessorHandoffCommand; readonly directive: ToolPostCommitDirective }) => Promise<void> {
    const schedule = options.schedule ?? deferPastTheBlock
    return async ({ command, directive }) => {
        if (directive.type !== "start_successor_task") return
        const runtime = options.runtime()
        if (!runtime || !command.turnId) throw new Error("NewTaskHandoffWithoutActiveTurn")
        const consumed = await runtime.submit({
            type: "lifecycle.consumed",
            generation: runtime.getState().generation,
            turnId: command.turnId,
            blockId: command.dlineTid,
            consumedRef: newTaskConsumedRef(directive),
        })
        if (consumed.kind === "rejected") return
        // A successor must never exist beside a source that could still resume.
        await runtime.waitForDurable(consumed.state.revision)
        // The model rewrites the context after Regenerate Context, but what the
        // user asked for is theirs, so it reaches the successor verbatim.
        const feedback =
            (await options.successor.feedback?.({ functionId: directive.functionId, dlineTid: directive.dlineTid })) ?? []
        const handoff = createNewTaskHandoff(directive, options.successor.settings(), feedback)
        schedule(() => {
            void options.successor.start(handoff).catch((error) => options.successor.onError?.(error))
        })
    }
}
