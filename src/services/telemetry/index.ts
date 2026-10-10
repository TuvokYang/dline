export type {
    EventTelemetryCapability,
    JournalTelemetryCapability,
    MetricTelemetryCapability,
    TelemetryChannel,
    TelemetryProviderBase,
    TelemetryProviderCapability,
    TelemetryProviderRegistration,
    TelemetrySeverity,
    TelemetrySinkDescriptor,
    TraceTelemetryCapability,
} from "./providers/capabilities"
export type {
    ITelemetryProvider,
    TelemetrySettings,
} from "./providers/ITelemetryProvider"
export { adaptLegacyTelemetryProvider } from "./providers/LegacyTelemetryProviderAdapter"
export { PostHogTelemetryProvider } from "./providers/posthog/PostHogTelemetryProvider"
export {
    type TelemetryProviderConfig,
    TelemetryProviderFactory,
    type TelemetryProviderType,
} from "./TelemetryProviderFactory"
// Export terminal type definitions for type-safe telemetry
export type {
    StandaloneOutputMethod,
    TerminalOutputMethod,
    TerminalType,
    VscodeOutputMethod,
} from "./TelemetryService"
// Export the enums and types for terminal telemetry
export {
    TerminalHangStage,
    TerminalOutputFailureReason,
    TerminalUserInterventionAction,
} from "./TelemetryService"

import { Logger } from "@/shared/services/Logger"
import { installObservabilityPipeline } from "./service/pipeline-port"
import { TelemetryService } from "./TelemetryService"

/**
 * Process-wide telemetry service.
 *
 * The instance is created synchronously on first use so that
 * `telemetryService.captureX()` stays a plain synchronous call. A proxy that
 * awaited construction would turn every capture into a Promise, and
 * `safeCapture` — the wrapper protecting tool execution and browser automation
 * from telemetry faults — cannot catch a rejection it never awaits.
 *
 * Providers and host metadata arrive asynchronously. Signals recorded before
 * they land are held by the provider registry and replayed in order, so the
 * activation events are reported rather than lost to the gap.
 */

let _telemetryServiceInstance: TelemetryService | null = null
let _providerAttachment: Promise<void> | null = null

/**
 * Whether shutdown has run.
 *
 * Teardown disposes telemetry before controllers release their tasks, and task
 * termination still reports — a cancelled task emits its focus-chain outcome.
 * Without this flag each late call would build a fresh service, attach real
 * providers to it, and leave them open with nothing left to close them.
 */
let _shutDown = false

/**
 * The live service, creating it if this is the first call.
 *
 * After shutdown the returned service has no providers and never acquires any,
 * so late calls are inert rather than resurrecting the singleton.
 */
export function getTelemetryServiceSync(): TelemetryService {
    if (!_telemetryServiceInstance) {
        const service = new TelemetryService([], TelemetryService.initialMetadata(), {
            deferProviders: !_shutDown,
        })
        _telemetryServiceInstance = service
        installObservabilityPipeline({
            recordHistogram: (name, value, attributes, description) =>
                service.recordHistogram(name, value, attributes, description, "runtime"),
            recordGauge: (name, value, attributes, description) =>
                service.recordGauge(name, value, attributes, description, "runtime"),
            startSpan: (options) => service.startSpan(options, "runtime"),
        })
        if (!_shutDown) {
            _providerAttachment = attachDeferredDependencies(service)
        }
    }
    return _telemetryServiceInstance
}

/**
 * The service with providers and host metadata attached.
 *
 * Callers that need providers to exist — the settings screen testing a
 * collector connection, for instance — must await this rather than reading
 * `getProviders()` off the proxy, which may still be mid-attachment.
 */
export async function getTelemetryService(): Promise<TelemetryService> {
    const service = getTelemetryServiceSync()
    await _providerAttachment
    return service
}

/**
 * Attach the pieces that require async work.
 *
 * Errors are logged rather than propagated: an extension must not fail to
 * activate because a telemetry provider could not be constructed. The registry
 * is still marked ready on failure, so held signals are released instead of
 * accumulating against a buffer bound that will never be relieved.
 */
async function attachDeferredDependencies(service: TelemetryService): Promise<void> {
    try {
        await service.attachProviders()
    } catch (error) {
        Logger.error("[TelemetryService] Failed to attach telemetry providers:", error)
        service.releasePendingSignals()
    }
}

/**
 * Shut down the process-wide service.
 *
 * Attachment is awaited first: disposing while providers are still being built
 * would let a provider be constructed after its owner is gone, leaving its
 * sockets and timers with nothing to close them.
 */
export async function disposeTelemetryService(): Promise<void> {
    // Set before the awaits so a call arriving mid-shutdown cannot start a new
    // attachment that would outlive this one.
    _shutDown = true
    installObservabilityPipeline(undefined)

    const service = _telemetryServiceInstance
    if (!service) {
        return
    }

    const attachment = _providerAttachment
    _telemetryServiceInstance = null
    _providerAttachment = null

    // Attachment already swallows its own failures; this only joins it.
    await attachment
    await service.dispose()
}

/**
 * Reset the telemetry service instance (useful for testing)
 *
 * Prefer `disposeTelemetryService` in production paths: this drops the
 * reference without closing providers.
 */
export function resetTelemetryService(): void {
    _telemetryServiceInstance = null
    _providerAttachment = null
    installObservabilityPipeline(undefined)
    _shutDown = false
}

/**
 * The call surface used across the extension.
 *
 * A proxy rather than the instance itself so that importing this module does
 * not construct the service — module load order across hosts is not something
 * call sites should have to reason about. Methods are forwarded synchronously
 * and keep their real return types.
 */
export const telemetryService = new Proxy({} as TelemetryService, {
    get(_target, prop, _receiver) {
        const service = getTelemetryServiceSync()
        const value = Reflect.get(service, prop, service)
        return typeof value === "function" ? value.bind(service) : value
    },
})
