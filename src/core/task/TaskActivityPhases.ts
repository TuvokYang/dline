import { TaskPhase } from "./TaskPhase"

/**
 * Phases in which the task loop still owns the conversation.
 *
 * A working task drives itself: it reaches the next provider request, tool
 * round or turn end on its own, without a user response. `BETWEEN_TURNS` in
 * particular is *not* an idle state — it is the gap between one finished turn
 * and the next provider request, and the loop in `initiateTaskLoop` is still
 * running through it. Treating that gap as "idle" lets the composer send input
 * into a conversation that has nobody waiting to receive it.
 *
 * Waiting for the user is expressed by an active interaction, never by a phase
 * on this list. `AWAITING_APPROVAL` is therefore absent: the task is parked on
 * an interaction that owns its own actions. That phase is still allowed to
 * *retain* queued input, which is a wider question answered separately by
 * `taskPhaseStillDelivers` in `@shared/InputQueueDelivery`.
 *
 * Written as an explicit list rather than as a negation of the terminal phases:
 * a newly added phase must opt in to being considered working, instead of
 * silently inheriting it.
 */
const WORKING_PHASES: ReadonlySet<TaskPhase> = new Set([
    TaskPhase.INITIALIZING,
    TaskPhase.STREAMING,
    TaskPhase.EXECUTING,
    TaskPhase.BETWEEN_TURNS,
    TaskPhase.RESUMING,
])

/**
 * Report whether the task loop is still advancing on its own in this phase.
 *
 * Single source of truth for two rules that must agree: whether the view may
 * offer Cancel, and whether cancellation actually interrupts work. They were
 * separate lists that had drifted apart over `BETWEEN_TURNS`, which left a
 * working task showing no Cancel button.
 */
export function isTaskWorkingPhase(phase: TaskPhase): boolean {
    return WORKING_PHASES.has(phase)
}

/**
 * Report the same fact for a phase that arrives as a plain string.
 *
 * The Webview receives the phase through the projection rather than as the
 * backend enum, so it cannot compare against {@link TaskPhase} directly. An
 * unknown value is not working: a phase this build does not know about must
 * not be granted the ability to hold the user's input.
 */
export function isTaskWorkingPhaseName(phase: string): boolean {
    return (WORKING_PHASES as ReadonlySet<string>).has(phase)
}
