import { parseWorkspaceInlinePath } from "./utils/parseWorkspaceInlinePath"
import { WorkspacePathAdapter } from "./WorkspacePathAdapter"
import { workspaceResolver } from "./WorkspaceResolver"
import type { WorkspaceRootManager } from "./WorkspaceRootManager"

/** A file link from chat, resolved to the file it names. */
export interface WorkspaceLinkTarget {
    absolutePath: string
    /** Line from a trailing `:<line>` suffix, passed to the editor unchanged. */
    line?: number
}

export interface WorkspaceLinkContext {
    /** Primary workspace root. Links without a workspace hint resolve against it. */
    cwd: string
    /**
     * Roots that a `@<workspace>:` hint is matched against. Without a manager the
     * hint is dropped and the path resolves against `cwd`.
     */
    workspaceManager?: WorkspaceRootManager
}

const LINE_SUFFIX = /^(.+):(\d+)$/
const TRACE_CONTEXT = "resolveWorkspaceLinkTarget"

/**
 * Resolves a file link rendered in chat to an absolute path and optional line.
 *
 * Links reuse the display form tools emit in multi-root workspaces,
 * `@<workspace>:<path>`, optionally followed by `:<line>`. The workspace hint is
 * parsed before the line suffix so its separator is never read as a line
 * delimiter. A hinted path is resolved with the same root matching the tools
 * use, so the link opens the file the tool actually touched; an unknown hint
 * falls back to the primary root, as it does for tools.
 */
export function resolveWorkspaceLinkTarget(link: string, context: WorkspaceLinkContext): WorkspaceLinkTarget {
    const { workspaceHint, relPath } = parseWorkspaceInlinePath(link)
    const { filePath, line } = splitLineSuffix(relPath)

    if (!workspaceHint) {
        const absolutePath = workspaceResolver.resolveWorkspacePath(context.cwd, filePath, TRACE_CONTEXT) as string
        return { absolutePath, line }
    }

    const adapter = new WorkspacePathAdapter({
        cwd: context.cwd,
        isMultiRootEnabled: true,
        workspaceManager: context.workspaceManager,
    })
    return { absolutePath: adapter.resolvePath(filePath, workspaceHint), line }
}

function splitLineSuffix(value: string): { filePath: string; line?: number } {
    const match = value.match(LINE_SUFFIX)
    if (!match) {
        return { filePath: value }
    }
    return { filePath: match[1], line: Number.parseInt(match[2], 10) }
}
