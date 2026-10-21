import { withDiagnosticSite } from "@shared/errors/diagnostic-site"
import { Logger } from "@shared/services/Logger"
import { redactDiagnosticString } from "@shared/services/logging/safe-diagnostic-value"
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
    const reported = domain === "provider" ? withDiagnosticSite(error, "provider.execute") : error
    if (isProfileRefusal(error)) Logger.warn(failure, reported)
    else Logger.error(failure, reported)
    return failure
}

/** Bounds the quoted error text; a failure message can embed whatever the failing code was handling. */
const MAX_FAILURE_DESCRIPTION_LENGTH = 1_000

/**
 * Describe an executor failure for the chat when no domain described it.
 *
 * `executorFailure` keeps only the failure kind because its text enters the
 * conversation. This text is the body of the chat's error box instead, so it
 * names the actual error: an interaction id or a bare kind cannot tell the user
 * what went wrong. Credentials are redacted and the message is bounded.
 *
 * @returns A serialized error the chat's error box parses: the message plus the error name as its code.
 */
export function describeExecutorFailure(domain: string, error: unknown): string {
    const name = error instanceof Error && error.name ? error.name : "Error"
    const detail = redactDiagnosticString(error instanceof Error ? error.message : String(error)).slice(
        0,
        MAX_FAILURE_DESCRIPTION_LENGTH,
    )
    return JSON.stringify({ message: `Dline ${domain} execution failed: ${detail || name}`, code: name })
}

/** A Profile refusal, also when a provider failure carries it as its cause to describe it for the chat. */
function isProfileRefusal(error: unknown): boolean {
    for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
        if (current instanceof ProfileNotValidError) return true
    }
    return false
}
