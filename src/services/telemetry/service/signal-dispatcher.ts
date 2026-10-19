import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import type { TelemetryContext } from "../context/telemetry-context"
import type { TelemetryCategory } from "../events/catalog"
import { routeOfEvent } from "../events/event-routes"
import type { TelemetryProperties } from "../providers/ITelemetryProvider"
import type { TelemetryCategoryPolicy } from "./category-policy"
import type { TelemetryProviderRegistry } from "./provider-registry"
import type { TelemetrySignalSink } from "./signal-sink"

/**
 * Joins context, category policy, and providers into the sink recorders use.
 *
 * This is the only place that knows an event carries host metadata while a
 * metric additionally carries account identity. Recorders state *what* happened
 * and this decides *what is attached* — so a change to identity handling is one
 * edit here rather than an audit of every capture method.
 */
export class TelemetrySignalDispatcher implements TelemetrySignalSink {
    constructor(
        private readonly context: TelemetryContext,
        private readonly providers: TelemetryProviderRegistry,
        private readonly categories: TelemetryCategoryPolicy,
    ) {}

    captureEvent(event: string, properties?: TelemetryProperties): void {
        const route = routeOfEvent(event)
        this.providers.logEvent(event, () => this.context.eventProperties(properties), false, route.channel, route.severity)
    }

    captureRequiredEvent(event: string, properties?: TelemetryProperties): void {
        const route = routeOfEvent(event)
        this.providers.logEvent(event, () => this.context.eventProperties(properties), true, route.channel, route.severity)
    }

    recordCounter(name: string, value: number, attributes?: TelemetryProperties, description?: string): void {
        this.providers.recordCounter(name, value, () => this.context.metricAttributes(attributes), description)
    }

    recordHistogram(name: string, value: number, attributes?: TelemetryProperties, description?: string): void {
        this.providers.recordHistogram(name, value, () => this.context.metricAttributes(attributes), description)
    }

    recordGauge(name: string, value: number | null, attributes?: TelemetryProperties, description?: string): void {
        this.providers.recordGauge(name, value, () => this.context.metricAttributes(attributes), description)
    }

    /**
     * Forward account identity through the dedicated account channel.
     *
     * The device-scoped `distinct_id` is deliberately untouched. Providers that
     * need account identity must opt into the account channel and keep it out of
     * ordinary usage, error, and runtime records.
     */
    identifyUser(userInfo: ClineAccountUserInfo): void {
        this.providers.identifyUser(userInfo, () => this.context.eventProperties())
    }

    isCategoryEnabled(category: TelemetryCategory): boolean {
        return this.categories.isEnabled(category)
    }
}
