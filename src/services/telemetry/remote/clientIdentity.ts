import type { UsageHostEditor, UsageReleaseChannel } from "./contracts/usageBody"

/**
 * How this build describes itself to the telemetry service: the release channel
 * and the hosting editor, in the service's fixed vocabulary. Usage reports them
 * in `client`, diagnostics in the logs resource.
 */

/** The release channel of a build, read from its extension name (`dline-insiders` for Insiders). */
export function releaseChannelOf(extensionName: string): UsageReleaseChannel {
    return extensionName.endsWith("-insiders") ? "insiders" : "stable"
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
