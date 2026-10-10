import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import { setDistinctId } from "../../logging/distinctId"
import type { TelemetryContext } from "../context/telemetry-context"
import type { TelemetryCategory } from "../events/catalog"
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
        this.providers.logEvent(event, () => this.context.eventProperties(properties), false)
    }

    captureRequiredEvent(event: string, properties?: TelemetryProperties): void {
        this.providers.logEvent(event, () => this.context.eventProperties(properties), true)
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
     * Attach an identity to this session and forward it to providers.
     *
     * The distinct id is also published to the logging package: error reports
     * raised outside the telemetry path must correlate with the same user, and
     * without this they would carry an unrelated anonymous id.
     */
    identifyUser(userInfo: ClineAccountUserInfo): void {
        this.context.identify(userInfo)
        this.providers.identifyUser(userInfo, () => this.context.eventProperties())
        if (userInfo.id) {
            setDistinctId(userInfo.id)
        }
    }

    isCategoryEnabled(category: TelemetryCategory): boolean {
        return this.categories.isEnabled(category)
    }
}
