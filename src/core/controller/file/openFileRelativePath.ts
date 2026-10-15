import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/dline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { resolveWorkspaceLink } from "./resolveWorkspaceLink"

/**
 * Opens a file link from chat in the editor.
 *
 * The link is workspace-relative, may carry a multi-root `@<workspace>:` hint,
 * and may end with `:<line>`, e.g. `@frontend:src/index.ts:42`.
 *
 * @param controller The controller instance
 * @param request The request message containing the link in the 'value' field
 * @returns Empty response
 */
export async function openFileRelativePath(controller: Controller, request: StringRequest): Promise<Empty> {
    if (!request.value) {
        return Empty.create()
    }

    const target = await resolveWorkspaceLink(controller, request.value)
    if (!target) {
        Logger.error("Error in openFileRelativePath: No workspace path available")
        return Empty.create()
    }

    openFileIntegration(target.absolutePath, false, false, target.line)
    return Empty.create()
}
