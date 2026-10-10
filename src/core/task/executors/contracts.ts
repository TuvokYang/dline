import { Logger } from "@shared/services/Logger"
import type { HaltStopCommand, ParticipantId, TaskEvent } from "../kernel"
import { ProfileNotValidError } from "../profile-admission"

export type TaskEventSubmission = { readonly kind: "accepted"; readonly durable?: Promise<void> } | { readonly kind: "rejected" }

export interface TaskEventSink {
    submit(event: TaskEvent): Promise<TaskEventSubmission>
}

export interface HaltOrder {
    readonly haltId: string
    readonly generation: number
    readonly reason: HaltStopCommand["reason"]
}

export interface HaltParticipant {
    readonly id: ParticipantId
    /** Establish an admission and callback fence synchronously, before any stop awaits. */
    fence(order: HaltOrder): void
    /** Request cancellation or resource shutdown. */
    stop(order: HaltOrder): void | Promise<void>
    /** Resolve only after participant-owned work and callbacks can no longer publish. */
    drain(order: HaltOrder): Promise<void>
    /** Retire only the named halt generation; older re-arms cannot clear a newer fence. */
    rearm?(haltId: string): void
}

export function isExecutionAbort(error: unknown, signal: AbortSignal): boolean {
    if (!signal.aborted) return false
    if (error === signal.reason) return true
    return error instanceof Error && error.name === "AbortError"
}

/**
 * Report one executor failure.
 *
 * The returned text enters the conversation, so it carries only a sanitized
 * failure kind. The original error is logged instead, because a bare error name
 * cannot explain why a provider, tool or compaction execution failed.
 */
export function executorFailure(domain: string, error: unknown): string {
    const candidate = error instanceof Error ? error.name : "unknown"
    const safeKind = /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : "unknown"
    const failure = `${domain} execution failed (${safeKind})`
    // A Profile that cannot admit the request is the user's to fix and is shown
    // to them as such; it is not a fault of the execution.
    if (isProfileRefusal(error)) Logger.warn(failure, error)
    else Logger.error(failure, error)
    return failure
}

/** A Profile refusal, also when a provider failure carries it as its cause to describe it for the chat. */
function isProfileRefusal(error: unknown): boolean {
    for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
        if (current instanceof ProfileNotValidError) return true
    }
    return false
}
