import type { UsageHostEditor, UsageReleaseChannel } from "./contracts/usageBodySchema"

/**
 * How this build describes itself to the telemetry service: the release channel
 * and the hosting editor, in the contract's fixed vocabulary. Usage reports them
 * in `client`, diagnostics in the logs resource.
 */

const MINOR_VERSION = /^\d+\.(\d+)\./u

/**
 * The release channel of a build. Insiders is a separate extension
 * (`dline-insiders`); a pre-release ships under the production name with an odd
 * minor version, so it must not report itself as stable (usage-contract §14).
 */
export function releaseChannelOf(extensionName: string, version: string): UsageReleaseChannel {
    if (extensionName.endsWith("-insiders")) return "insiders"
    const minor = MINOR_VERSION.exec(version)?.[1]
    return minor !== undefined && Number(minor) % 2 === 1 ? "pre-release" : "stable"
}

/** The editor hosting the extension, from its application name. */
export function hostEditorOf(appName: string | undefined): UsageHostEditor {
    const name = (appName ?? "").toLowerCase()
    if (name.includes("cursor")) return "cursor"
    if (name.includes("windsurf")) return "windsurf"
    if (name.includes("vscodium")) return "vscodium"
    if (name.includes("visual studio code") || name.includes("vscode")) return "vscode"
    return "other"
}
