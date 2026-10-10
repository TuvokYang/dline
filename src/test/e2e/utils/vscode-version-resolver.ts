import e2eVersions from "../vscode-version.json"

export type VSCodeDownloadChannel = "stable" | "insiders"
export type VSCodeDownloadPlatform =
    | "darwin"
    | "darwin-arm64"
    | "win32-x64-archive"
    | "win32-arm64-archive"
    | "linux-x64"
    | "linux-arm64"
    | "linux-armhf"

export const E2E_VSCODE_STABLE_VERSION = e2eVersions.stable
export const E2E_VSCODE_DOWNLOAD_TIMEOUT_MS = e2eVersions.downloadTimeoutMs

/**
 * Resolve the VS Code download platform used by @vscode/test-electron for the current host.
 */
export function resolveVSCodeDownloadPlatform(
    platform: NodeJS.Platform = process.platform,
    architecture: string = process.arch,
): VSCodeDownloadPlatform {
    if (platform === "win32") return architecture === "arm64" ? "win32-arm64-archive" : "win32-x64-archive"
    if (platform === "darwin") return architecture === "arm64" ? "darwin-arm64" : "darwin"
    if (architecture === "arm64") return "linux-arm64"
    if (architecture === "arm") return "linux-armhf"
    return "linux-x64"
}

/** Resolve the repository-pinned VS Code build instead of following the mutable Stable channel. */
export function resolveVSCodeDownloadVersion(
    channel: VSCodeDownloadChannel,
    _cachePath: string,
    _platform: VSCodeDownloadPlatform,
): string {
    return channel === "stable" ? E2E_VSCODE_STABLE_VERSION : channel
}
