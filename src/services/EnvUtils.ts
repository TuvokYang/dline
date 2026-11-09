import { isMultiRootWorkspace } from "@/core/workspace/utils/workspace-detection"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { EmptyRequest } from "@/shared/proto/dline/common"
import { Logger } from "@/shared/services/Logger"

// Canonical header names for extra client/host context
export const ClineHeaders = {
    PLATFORM: "X-PLATFORM",
    PLATFORM_VERSION: "X-PLATFORM-VERSION",
    CLIENT_VERSION: "X-CLIENT-VERSION",
    CLIENT_TYPE: "X-CLIENT-TYPE",
    CORE_VERSION: "X-CORE-VERSION",
    IS_MULTIROOT: "X-IS-MULTIROOT",
} as const
export type ClineHeaderName = (typeof ClineHeaders)[keyof typeof ClineHeaders]

/**
 * Version characters every Dline service accepts: letters, digits, dots, plus
 * and hyphen, at most 32. The telemetry contract checks `client.version` with
 * this same alphabet, so a version announced here is one the service accepts.
 */
export const DLINE_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/u
/** A complete Dline agent: `Dline/<version>` with no trailing detail. */
export const DLINE_USER_AGENT_PATTERN = /^Dline\/[0-9A-Za-z.+-]{1,32}$/u

/**
 * The one place this build states its identity as `Dline/<version>`.
 *
 * Every Dline service reads it: the OpenAI-compatible clients and providers via
 * {@link buildExternalBasicHeaders}, and the telemetry transport, the usage
 * replay manifest and its read-back check via the explicit `version` argument.
 * The telemetry service compares the agent's version against `client.version`
 * of the body and fingerprints a replay on the exact string, so a second
 * formatter is how those two drift into `client-version-mismatch`.
 *
 * Pass `version` when the caller already resolved the version it reports in a
 * body; omit it to announce this extension's own version.
 */
export function dlineUserAgent(version: string = ExtensionRegistryInfo.version): string {
    return `Dline/${version}`
}

/** Whether a persisted agent is one this build would accept back. */
export function isDlineUserAgent(value: string): boolean {
    return DLINE_USER_AGENT_PATTERN.test(value)
}

export function buildExternalBasicHeaders(): Record<string, string> {
    return {
        "User-Agent": dlineUserAgent(),
    }
}

export async function buildBasicClineHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = buildExternalBasicHeaders()
    try {
        const host = await HostProvider.env.getHostVersion(EmptyRequest.create({}))
        headers[ClineHeaders.PLATFORM] = host.platform || "unknown"
        headers[ClineHeaders.PLATFORM_VERSION] = host.version || "unknown"
        headers[ClineHeaders.CLIENT_TYPE] = host.clineType || "unknown"
        headers[ClineHeaders.CLIENT_VERSION] = host.clineVersion || "unknown"
    } catch (error) {
        Logger.log("Failed to get IDE/platform info via HostBridge EnvService.getHostVersion", error)
        headers[ClineHeaders.PLATFORM] = "unknown"
        headers[ClineHeaders.PLATFORM_VERSION] = "unknown"
        headers[ClineHeaders.CLIENT_TYPE] = "unknown"
        headers[ClineHeaders.CLIENT_VERSION] = "unknown"
    }
    headers[ClineHeaders.CORE_VERSION] = ExtensionRegistryInfo.version

    return headers
}

export async function buildClineExtraHeaders(): Promise<Record<string, string>> {
    const headers = await buildBasicClineHeaders()

    try {
        const isMultiRoot = await isMultiRootWorkspace()
        headers[ClineHeaders.IS_MULTIROOT] = isMultiRoot ? "true" : "false"
    } catch (error) {
        Logger.log("Failed to detect multi-root workspace", error)
        headers[ClineHeaders.IS_MULTIROOT] = "false"
    }

    return headers
}
