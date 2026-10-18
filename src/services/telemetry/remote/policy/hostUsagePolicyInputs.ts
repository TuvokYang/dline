import { StateManager } from "@/core/storage/StateManager"
import type { LocalUsagePolicyInputs } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { HostProvider } from "@/hosts/host-provider"
import { Setting } from "@/shared/proto/dline/host"
import { isTelemetryDevelopmentMode } from "../../development-mode"
import type { HostTelemetryLevel } from "./usagePolicy"

const HOST_TELEMETRY_LEVELS: readonly HostTelemetryLevel[] = ["all", "error", "crash", "off"]

/**
 * Read the remote usage policy inputs of this extension host.
 *
 * Organization policy is read from the remote configuration alone, because the
 * effective setting already merges it with the user's choice and could not tell
 * the two apart. A host level that cannot be read counts as "off".
 */
export async function readHostUsagePolicyInputs(): Promise<LocalUsagePolicyInputs> {
    const stateManager = StateManager.get()
    return {
        usageConsent: stateManager.getGlobalSettingsKey("usageReportingSetting") ?? "unset",
        // Recorded when the user confirms the remote usage disclosure; until then every opt-in stays local.
        acknowledgedConsentRevision: undefined,
        organizationDisabled: stateManager.getRemoteConfigSettings().usageReportingSetting === "disabled",
        hostTelemetryLevel: await readHostTelemetryLevel(),
        isDevelopmentBuild: isTelemetryDevelopmentMode(),
        developmentEnrolled: false,
    }
}

async function readHostTelemetryLevel(): Promise<HostTelemetryLevel> {
    try {
        const settings = await HostProvider.env.getTelemetrySettings({})
        if (settings.isEnabled === Setting.DISABLED) return "off"
        const level = settings.errorLevel ?? "all"
        return HOST_TELEMETRY_LEVELS.includes(level as HostTelemetryLevel) ? (level as HostTelemetryLevel) : "off"
    } catch {
        return "off"
    }
}
