import { workspaceResolver } from "@core/workspace"
import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/dline/common"
import { getWorkspacePath } from "@utils/path"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Opens a file in the editor by a relative path
 * @param controller The controller instance
 * @param request The request message containing the relative file path in the 'value' field
 * @returns Empty response
 */
export async function openFileRelativePath(_controller: Controller, request: StringRequest): Promise<Empty> {
    const workspacePath = await getWorkspacePath()

    if (!workspacePath) {
        Logger.error("Error in openFileRelativePath: No workspace path available")
        return Empty.create()
    }

    if (request.value) {
        // Parse optional line number suffix: "path/to/file.ts:42"
        let filePath = request.value
        let lineNumber: number | undefined
        const lineMatch = filePath.match(/^(.+):(\d+)$/)
        if (lineMatch) {
            filePath = lineMatch[1]
            lineNumber = Number.parseInt(lineMatch[2], 10)
        }

        // Resolve the relative path to absolute path
        const resolvedPath = workspaceResolver.resolveWorkspacePath(workspacePath, filePath, "Controller.openFileRelativePath")
        const absolutePath = typeof resolvedPath === "string" ? resolvedPath : resolvedPath.absolutePath

        // Open the file using the existing integration
        openFileIntegration(absolutePath, false, false, lineNumber)
    }

    return Empty.create()
}
