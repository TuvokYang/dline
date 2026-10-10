import type {
    EventTelemetryCapability,
    MetricTelemetryCapability,
    TelemetryProviderCapability,
    TelemetryProviderRegistration,
    TelemetrySinkDescriptor,
} from "./capabilities"
import type { ITelemetryProvider } from "./ITelemetryProvider"

export interface LegacyTelemetryProviderAdapterOptions {
    readonly sink?: TelemetrySinkDescriptor
    readonly capabilities?: readonly ("event" | "metric")[]
}

const TEST_SINK: TelemetrySinkDescriptor = {
    kind: "test",
    origin: "test",
    channels: ["usage"],
}

/**
 * Adapts the legacy all-method provider contract to explicit capabilities.
 *
 * The adapter is intentionally the only place that knows every legacy method.
 * New providers register only the capabilities they actually implement.
 */
export function adaptLegacyTelemetryProvider(
    provider: ITelemetryProvider,
    options: LegacyTelemetryProviderAdapterOptions = {},
): TelemetryProviderRegistration {
    const declared = options.capabilities ?? ["event", "metric"]
    const capabilities: TelemetryProviderCapability[] = []

    for (const capability of declared) {
        switch (capability) {
            case "event":
                capabilities.push(eventCapability(provider))
                break
            case "metric":
                capabilities.push(metricCapability(provider))
                break
            default: {
                const unhandled: never = capability
                throw new Error(`Unhandled legacy telemetry capability: ${unhandled}`)
            }
        }
    }

    return {
        kind: "registration",
        base: provider,
        legacy: provider,
        sink: options.sink ?? TEST_SINK,
        capabilities,
    }
}

function eventCapability(provider: ITelemetryProvider): EventTelemetryCapability {
    return {
        kind: "event",
        log: provider.log.bind(provider),
        logRequired: provider.logRequired.bind(provider),
        identifyUser: provider.identifyUser.bind(provider),
    }
}

function metricCapability(provider: ITelemetryProvider): MetricTelemetryCapability {
    return {
        kind: "metric",
        recordCounter: (name, value, attributes, description) =>
            provider.recordCounter(name, value, attributes, description, false),
        recordHistogram: (name, value, attributes, description) =>
            provider.recordHistogram(name, value, attributes, description, false),
        recordGauge: (name, value, attributes, description) => provider.recordGauge(name, value, attributes, description, false),
    }
}
