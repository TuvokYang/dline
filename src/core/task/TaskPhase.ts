/**
 * Task lifecycle phase — the single source of truth for task state.
 * Replaces scattered boolean flags (abort, isStreaming, isInitialized, etc.)
 * that previously required complex conditional inference across the codebase.
 */
export enum TaskPhase {
    /** Task object created, not yet initialized */
    IDLE = "idle",
    /** Loading historical messages from disk */
    INITIALIZING = "initializing",
    /** Waiting for user to input a task description */
    WAITING_FOR_TASK = "waiting_for_task",
    /** API is streaming the assistant's response */
    STREAMING = "streaming",
    /** Waiting for user approval (tool / plan / qna / followup) */
    AWAITING_APPROVAL = "awaiting_approval",
    /** Executing one or more tools (serial or parallel) */
    EXECUTING = "executing",
    /** Between turns — waiting for the next API request */
    BETWEEN_TURNS = "between_turns",
    /** Resuming from previously interrupted history */
    RESUMING = "resuming",
    /** Cancellation in progress (user cancel / hook cancel / abort) */
    CANCELLING = "cancelling",
    /** Irrecoverably aborted */
    ABORTED = "aborted",
    /** Task completed normally (attempt_completion confirmed) */
    COMPLETED = "completed",
    /** Paused — recoverable via resume */
    PAUSED = "paused",
}
