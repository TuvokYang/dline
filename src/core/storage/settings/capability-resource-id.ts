import * as path from "node:path"

/**
 * Stable identifier for one capability resource inside a toggle preference map.
 *
 * Preferences survive across launches, upgrades and machines, so the key must
 * not change when the same file is reached through a different path form. A
 * scan that produces `C:\ws\.clinerules\a.md` on one launch and
 * `c:/ws/.clinerules/a.md` on the next would otherwise look like a deleted
 * resource plus a brand new one, silently resetting the user's choice.
 */
export type CapabilityResourceId = string

/** Windows and macOS resolve paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE_PLATFORM = process.platform === "win32" || process.platform === "darwin"

/**
 * Normalize one discovered resource path into a stable preference key.
 *
 * When `root` is given the id is relative to it, so moving a workspace or
 * global directory does not invalidate its preferences. Paths outside the root
 * keep their absolute form rather than escaping through `..` segments, which
 * would depend on the root's own depth.
 */
export function capabilityResourceId(resourcePath: string, root?: string): CapabilityResourceId {
    const trimmed = resourcePath.trim()
    if (trimmed === "") return ""

    // Remote resources are addressed by name, not by a filesystem path.
    if (trimmed.startsWith("remote:")) {
        return `remote:${normalizeCase(trimmed.slice("remote:".length))}`
    }

    const absolute = path.resolve(trimmed)
    const relative = root ? relativeToRoot(absolute, path.resolve(root)) : undefined
    return normalizeCase(toPosix(relative ?? absolute))
}

/** Returns undefined when the path is not contained in the root. */
function relativeToRoot(absolute: string, root: string): string | undefined {
    const relative = path.relative(root, absolute)
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
    return relative
}

/** Preference keys always use forward slashes so they read the same on every platform. */
function toPosix(value: string): string {
    return value.replace(/\\/g, "/").replace(/\/+$/, "")
}

function normalizeCase(value: string): string {
    return CASE_INSENSITIVE_PLATFORM ? value.toLowerCase() : value
}
