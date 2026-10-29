import { hasWorkspaceHint, resolveWorkspaceLinkTarget, type WorkspaceLinkTarget } from "@core/workspace"
import { getWorkspacePath } from "@utils/path"
import type { Controller } from ".."

/**
 * Resolves a file link from chat against the open workspace.
 *
 * Only a `@<workspace>:` hinted link consults the workspace manager. Unhinted
 * links keep resolving against the primary root, and inline-code existence
 * checks run for every path-like token, so they must not trigger root detection.
 *
 * @returns undefined when no workspace is open.
 */
export async function resolveWorkspaceLink(controller: Controller, link: string): Promise<WorkspaceLinkTarget | undefined> {
    const cwd = await getWorkspacePath()
    if (!cwd) {
        return undefined
    }
    const workspaceManager = hasWorkspaceHint(link) ? await controller.ensureWorkspaceManager() : undefined
    return resolveWorkspaceLinkTarget(link, { cwd, workspaceManager })
}
