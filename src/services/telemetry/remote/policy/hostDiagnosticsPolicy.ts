import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { Setting } from "@/shared/proto/dline/host"
import { isReportingAllowed, type TelemetrySetting } from "@/shared/TelemetrySetting"
import type { TelemetrySettings } from "../../providers/ITelemetryProvider"
import type { HostTelemetryLevel } from "./usagePolicy"

const HOST_TELEMETRY_LEVELS: readonly HostTelemetryLevel[] = ["all", "error", "crash", "off"]
const HOST_TELEMETRY_OFF: TelemetrySettings = { hostEnabled: false, level: "off" }

/**
 * Whether error and runtime diagnostics may leave the machine.
 *
 * The effective error-reporting setting already folds in an organization that
 * disables it, so consent and the host telemetry level are the whole decision.
 * Severity below the host level is filtered per record by the channel policy.
 */
export function diagnosticsAllowed(errorConsent: TelemetrySetting, host: TelemetrySettings): boolean {
    return isReportingAllowed(errorConsent) && host.hostEnabled && host.level !== undefined && host.level !== "off"
}

/**
 * Host-backed diagnostics policy: keeps the last host telemetry settings so the
 * synchronous telemetry pipeline can ask without awaiting the host bridge.
 */
export class HostDiagnosticsPolicy {
    private host: TelemetrySettings = HOST_TELEMETRY_OFF

    private constructor(private readonly readConsent: () => TelemetrySetting) {}

    /** Read the host settings once and follow later host changes; `onChange` runs after each update. */
    static async start(onChange: () => void): Promise<HostDiagnosticsPolicy> {
        const policy = new HostDiagnosticsPolicy(readErrorConsent)
        policy.host = await readHostTelemetrySettings()
        HostProvider.env.subscribeToTelemetrySettings(
            {},
            {
                onResponse: () => {
                    void readHostTelemetrySettings().then((settings) => {
                        policy.host = settings
                        onChange()
                    })
                },
            },
        )
        return policy
    }

    readonly allowed = (): boolean => diagnosticsAllowed(this.readConsent(), this.host)

    readonly hostSettings = (): TelemetrySettings => ({ ...this.host })
}

function readErrorConsent(): TelemetrySetting {
    try {
        return StateManager.get().getGlobalSettingsKey("errorReportingSetting") ?? "enabled"
    } catch {
        // Storage not ready means consent cannot be confirmed.
        return "unset"
    }
}

/** A host that cannot be read counts as telemetry off. */
async function readHostTelemetrySettings(): Promise<TelemetrySettings> {
    try {
        const settings = await HostProvider.env.getTelemetrySettings({})
        if (settings.isEnabled === Setting.DISABLED) return HOST_TELEMETRY_OFF
        const level = (settings.errorLevel ?? "all") as HostTelemetryLevel
        return HOST_TELEMETRY_LEVELS.includes(level) ? { hostEnabled: true, level } : HOST_TELEMETRY_OFF
    } catch {
        return HOST_TELEMETRY_OFF
    }
}
