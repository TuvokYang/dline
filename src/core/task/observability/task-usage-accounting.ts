import type { ProviderAttemptUsageEvent } from "../performance/provider-request-round-port"

/** Process-wide durable projection of canonical Task telemetry facts. */
export interface TaskUsageAccountingSink {
    currentPolicyGeneration(): number | undefined
    recordAttemptEvent(event: ProviderAttemptUsageEvent): void
}

let activeSink: TaskUsageAccountingSink | undefined

/** Install the current host's durable Usage sink without exposing it to Task composition. */
export function installTaskUsageAccountingSink(sink: TaskUsageAccountingSink): () => void {
    activeSink = sink
    return () => {
        if (activeSink === sink) activeSink = undefined
    }
}

/** Stable Task-facing projection; absence fails closed and never changes Task behavior. */
export const taskUsageAccounting: TaskUsageAccountingSink = {
    currentPolicyGeneration: () => {
        try {
            return activeSink?.currentPolicyGeneration()
        } catch {
            return undefined
        }
    },
    recordAttemptEvent: (event) => {
        try {
            activeSink?.recordAttemptEvent(event)
        } catch {
            // Durable accounting must never replace the Task result.
        }
    },
}
