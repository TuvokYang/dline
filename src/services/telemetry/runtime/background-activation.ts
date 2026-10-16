import { activateRuntimeTelemetry, type RuntimeTelemetryActivationOptions } from "./activation"
import type { RuntimeTelemetryLifecycle } from "./lifecycle"

export type RuntimeTelemetryActivator = (options: RuntimeTelemetryActivationOptions) => Promise<RuntimeTelemetryLifecycle>

export interface BackgroundRuntimeTelemetryActivationObservers {
    readonly onStarted?: (lifecycle: RuntimeTelemetryLifecycle) => void
    readonly onError?: (error: unknown) => void
}

/**
 * Start runtime telemetry without joining its lifecycle to extension readiness.
 *
 * Telemetry may reconcile local journals, construct exporters, or retire an old
 * pipeline. None of that work is allowed to delay controllers, Task admission,
 * or provider requests, so this boundary owns and observes the detached promise.
 */
export function startRuntimeTelemetryInBackground(
    options: RuntimeTelemetryActivationOptions,
    observers: BackgroundRuntimeTelemetryActivationObservers = {},
    activate: RuntimeTelemetryActivator = activateRuntimeTelemetry,
): void {
    let activation: Promise<RuntimeTelemetryLifecycle>
    try {
        activation = activate(options)
    } catch (error) {
        notifyError(observers.onError, error)
        return
    }

    void activation.then(
        (lifecycle) => {
            try {
                observers.onStarted?.(lifecycle)
            } catch (error) {
                notifyError(observers.onError, error)
            }
        },
        (error: unknown) => notifyError(observers.onError, error),
    )
}

function notifyError(observer: ((error: unknown) => void) | undefined, error: unknown): void {
    try {
        observer?.(error)
    } catch {
        // An observability failure reporter must not create another unhandled error.
    }
}
