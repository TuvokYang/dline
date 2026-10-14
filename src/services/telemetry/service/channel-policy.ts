import { StateManager } from "@/core/storage/StateManager"
import type { ReportingConsents } from "@/shared/TelemetrySetting"
import { isReportingAllowed } from "@/shared/TelemetrySetting"
import type { TelemetryChannel, TelemetryProviderRegistration, TelemetrySeverity } from "../providers/capabilities"

export interface TelemetryPolicySignal {
    readonly channel: TelemetryChannel
    readonly severity: TelemetrySeverity
    readonly required?: boolean
}

export interface TelemetryChannelPolicyOptions {
    readonly readConsents?: () => ReportingConsents
    readonly rawArtifactAllowed?: () => boolean
}

/** Central consent and host-level gate applied before properties are materialised. */
export class TelemetryChannelPolicy {
    private readonly readConsents: () => ReportingConsents
    private readonly rawArtifactAllowed: () => boolean

    constructor(options: TelemetryChannelPolicyOptions = {}) {
        this.readConsents = options.readConsents ?? readStateManagerConsents
        this.rawArtifactAllowed = options.rawArtifactAllowed ?? (() => false)
    }

    static fromStateManager(): TelemetryChannelPolicy {
        return new TelemetryChannelPolicy()
    }

    static allowAll(): TelemetryChannelPolicy {
        return new TelemetryChannelPolicy({
            readConsents: () => ({ usage: "enabled", error: "enabled" }),
            rawArtifactAllowed: () => true,
        })
    }

    allows(signal: TelemetryPolicySignal, registration: TelemetryProviderRegistration): boolean {
        if (!registration.sink.channels.includes(signal.channel)) {
            return false
        }
        if (registration.sink.kind === "test") {
            return true
        }
        if (!this.isChannelEnabled(signal.channel)) {
            return false
        }
        if (!registration.base.isEnabled()) {
            return false
        }
        return severityAllowed(registration.base.getSettings().level, signal.severity)
    }

    isChannelEnabled(channel: TelemetryChannel): boolean {
        if (channel === "raw-artifact") {
            return this.rawArtifactAllowed()
        }
        const consents = this.readConsents()
        switch (channel) {
            case "usage":
            case "account":
                return isReportingAllowed(consents.usage)
            case "error":
            case "runtime":
                return isReportingAllowed(consents.error)
            default: {
                const unhandled: never = channel
                return unhandled
            }
        }
    }
}

function readStateManagerConsents(): ReportingConsents {
    try {
        const stateManager = StateManager.get()
        return {
            usage: stateManager.getGlobalSettingsKey("usageReportingSetting") ?? "unset",
            error: stateManager.getGlobalSettingsKey("errorReportingSetting") ?? "unset",
        }
    } catch {
        // Startup may reach telemetry before storage is ready. Unknown consent is off.
        return { usage: "unset", error: "unset" }
    }
}

function severityAllowed(
    level: ReturnType<TelemetryProviderRegistration["base"]["getSettings"]>["level"],
    severity: TelemetrySeverity,
): boolean {
    switch (level) {
        case undefined:
        case "all":
            return true
        case "off":
            return false
        case "error":
            return severity === "error" || severity === "fatal"
        case "crash":
            return severity === "fatal"
        default: {
            const unhandled: never = level
            return unhandled
        }
    }
}
