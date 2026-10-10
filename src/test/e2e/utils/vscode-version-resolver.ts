import { type Dirent, existsSync, readdirSync } from "node:fs"
import * as path from "node:path"

export type VSCodeDownloadChannel = "stable" | "insiders"
export type VSCodeDownloadPlatform =
    | "darwin"
    | "darwin-arm64"
    | "win32-x64-archive"
    | "win32-arm64-archive"
    | "linux-x64"
    | "linux-arm64"
    | "linux-armhf"

interface StableVersionCandidate {
    version: string
    parts: readonly number[]
}

function parseStableVersion(version: string): readonly number[] | undefined {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined
    return version.split(".").map(Number)
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0)
        if (difference !== 0) return difference
    }
    return 0
}

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

/**
 * Prefer the newest complete local stable install so E2E startup does not depend on release metadata availability.
 * A missing cache preserves @vscode/test-electron's normal online channel resolution.
 */
export function resolveVSCodeDownloadVersion(
    channel: VSCodeDownloadChannel,
    cachePath: string,
    platform: VSCodeDownloadPlatform,
): string {
    if (channel !== "stable") return channel

    let entries: Dirent<string>[]
    try {
        entries = readdirSync(cachePath, { encoding: "utf8", withFileTypes: true })
    } catch {
        return channel
    }

    const prefix = `vscode-${platform}-`
    const candidates: StableVersionCandidate[] = []
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
        const version = entry.name.slice(prefix.length)
        const parts = parseStableVersion(version)
        if (!parts || !existsSync(path.join(cachePath, entry.name, "is-complete"))) continue
        candidates.push({ version, parts })
    }

    candidates.sort((left, right) => compareVersionParts(right.parts, left.parts))
    return candidates[0]?.version ?? channel
}
