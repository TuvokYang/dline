import type { ProviderAttemptTerminalStatus } from "@shared/provider-attempt-observer"
import { type SignalSpanHandle, startSignalSpan } from "@/services/telemetry/service/pipeline-port"
import { Logger } from "@/shared/services/Logger"
import { usageFailureClassOf } from "./provider-failure"

/** What one Provider send is known by once its attempt observation began. */
export interface ProviderSendIdentity {
    /** The attempt observation id Usage reports for the same send. */
    readonly roundId: string
    readonly logicalRequestId: string
    /** Sends of the logical request before this one; 0 for the first. */
    readonly providerAttempt: number
    readonly role?: string
    readonly provider?: string
    /** The usage-contract §3.1 projection, frozen at admission. */
    readonly modelId?: string
}

/**
 * Start the span of one Provider send, `gen_ai.client.operation` (TADR §5.3).
 * Its attributes name the send exactly as Usage does, so a trace, the
 * duration histogram and a Usage fact of the same send correlate.
 */
export function startProviderSendSpan(identity: ProviderSendIdentity): SignalSpanHandle | undefined {
    try {
        return startSignalSpan({
            name: "gen_ai.client.operation",
            attributes: {
                "gen_ai.operation.name": "chat",
                ...(identity.provider ? { "gen_ai.provider.name": identity.provider } : {}),
                ...(identity.modelId ? { "gen_ai.request.model": identity.modelId } : {}),
                ...(identity.role ? { "dline.role": identity.role } : {}),
                "retry.attempt": identity.providerAttempt,
                "dline.attempt_observation_id": identity.roundId,
                "dline.logical_request_id": identity.logicalRequestId,
            },
        })
    } catch {
        Logger.debug("[ProviderSendSpan] Unable to start the send span")
        return undefined
    }
}

/** End the span with the send's outcome; a failure names its class, a stop is not an error. */
export function endProviderSendSpan(
    span: SignalSpanHandle | undefined,
    status: ProviderAttemptTerminalStatus,
    failure?: unknown,
): void {
    if (!span) return
    try {
        if (status === "failed") span.setAttribute("error.type", usageFailureClassOf(failure))
        span.end(status === "completed" ? "success" : status === "failed" ? "failure" : "cancelled")
    } catch {
        Logger.debug("[ProviderSendSpan] Unable to end the send span")
    }
}
