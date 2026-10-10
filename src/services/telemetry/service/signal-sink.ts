import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import type { TelemetryCategory } from "../events/catalog"
import type { TelemetryProperties } from "../providers/ITelemetryProvider"

/**
 * What a domain recorder is allowed to do.
 *
 * Recorders describe product behaviour; they must not know how many providers
 * exist, how metadata is merged, or whether a provider supports metrics. This
 * interface is the whole of their world, which is what makes each recorder
 * testable against a small fake instead of a wired-up service.
 */
export interface TelemetrySignalSink {
    /** Emit an event. Metadata and provider fan-out are the sink's concern. */
    captureEvent(event: string, properties?: TelemetryProperties): void

    /**
     * Emit an event that must be delivered even as reporting is switched off.
     *
     * Reserved for the consent transition itself: an opt-out event has to leave
     * before the setting takes effect or the transition becomes invisible.
     */
    captureRequiredEvent(event: string, properties?: TelemetryProperties): void

    recordCounter(name: string, value: number, attributes?: TelemetryProperties, description?: string): void
    recordHistogram(name: string, value: number, attributes?: TelemetryProperties, description?: string): void

    /**
     * Record a point-in-time value.
     *
     * `null` retires the series identified by name plus attributes; callers
     * must pass the same attribute set they recorded with, otherwise a stale
     * series is left behind.
     */
    recordGauge(name: string, value: number | null, attributes?: TelemetryProperties, description?: string): void

    identifyUser(userInfo: ClineAccountUserInfo): void

    /** Whether a switchable event category is currently collecting. */
    isCategoryEnabled(category: TelemetryCategory): boolean
}
