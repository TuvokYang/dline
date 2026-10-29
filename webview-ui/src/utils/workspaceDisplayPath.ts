import type { WorkspaceRoot } from "@shared/multi-root/types"

/** The workspace folders a reported path is shown against. */
export interface WorkspaceDisplayContext {
    workspaceRoots: readonly Pick<WorkspaceRoot, "path" | "name">[]
    primaryRootIndex: number
}

/** Formats one reported path for display. */
export type WorkspacePathFormatter = (reportedPath: string) => string

/** `@name:relative/path`, the form a tool uses to name a folder of a multi-root workspace. */
const WORKSPACE_HINT = /^@([^:/\\]+):(.*)$/
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/])/
const DRIVE_PATH = /^[a-zA-Z]:/

const toPosix = (path: string) => path.replace(/\\/g, "/")
const trimLeadingSlashes = (path: string) => path.replace(/^\/+/, "")
const trimTrailingSlashes = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path)

function folderName(root: Pick<WorkspaceRoot, "path" | "name">): string {
    return root.name || trimTrailingSlashes(toPosix(root.path)).split("/").pop() || root.path
}

/** The path of `target` below `root`, or undefined when it is not inside it. Drive paths compare without case. */
function pathInside(root: string, target: string): string | undefined {
    const base = trimTrailingSlashes(toPosix(root))
    const candidate = toPosix(target)
    const fold = DRIVE_PATH.test(base) ? (value: string) => value.toLowerCase() : (value: string) => value
    if (fold(candidate) === fold(base)) return ""
    const prefix = `${base}/`
    return fold(candidate).startsWith(fold(prefix)) ? candidate.slice(prefix.length) : undefined
}

/**
 * The text a row shows for a path the extension reported.
 *
 * Inside the workspace the path is relative; when several folders are open it is
 * prefixed with the folder's name so equal relative paths stay distinguishable.
 * Only a path outside every folder stays absolute. This is display text: the
 * reported path remains the value a click opens.
 */
export function formatWorkspaceDisplayPath(reportedPath: string, context: WorkspaceDisplayContext): string {
    if (!reportedPath) return reportedPath
    const roots = context.workspaceRoots
    const multiRoot = roots.length > 1
    const shown = (root: Pick<WorkspaceRoot, "path" | "name">, relative: string) => {
        const path = trimLeadingSlashes(relative)
        if (!multiRoot) return path || folderName(root)
        return path ? `${folderName(root)}/${path}` : folderName(root)
    }

    const hint = WORKSPACE_HINT.exec(reportedPath)
    if (hint) {
        const relative = trimLeadingSlashes(toPosix(hint[2]))
        return relative ? `${hint[1]}/${relative}` : hint[1]
    }

    if (ABSOLUTE_PATH.test(reportedPath)) {
        // The longest matching root wins, so a folder nested in another keeps its own name.
        const owners = roots
            .map((root) => ({ root, relative: pathInside(root.path, reportedPath) }))
            .filter(
                (entry): entry is { root: Pick<WorkspaceRoot, "path" | "name">; relative: string } =>
                    entry.relative !== undefined,
            )
            .sort((left, right) => right.root.path.length - left.root.path.length)
        return owners[0] ? shown(owners[0].root, owners[0].relative) : reportedPath
    }

    // A relative path is relative to the primary folder, the one the task runs in.
    const relative = toPosix(reportedPath).replace(/^\.\//, "")
    const primary = roots[context.primaryRootIndex] ?? roots[0]
    if (!multiRoot || !primary || relative.startsWith("../")) return relative
    return shown(primary, relative)
}
