import { BooleanResponse, StringRequest } from "@shared/proto/dline/common"
import * as fs from "fs"
import type { Controller } from ".."
import { resolveWorkspaceLink } from "./resolveWorkspaceLink"

/**
 * Checks whether a file link from chat names an existing file.
 *
 * Resolves the link exactly as openFileRelativePath does, including a
 * multi-root `@<workspace>:` hint and a trailing `:<line>`, so a link is only
 * offered when opening it would succeed.
 *
 * @param controller The controller instance
 * @param request The request containing the link to check
 * @returns BooleanResponse indicating whether the file exists
 */
export async function ifFileExistsRelativePath(controller: Controller, request: StringRequest): Promise<BooleanResponse> {
    if (!request.value) {
        return BooleanResponse.create({ value: false })
    }

    const target = await resolveWorkspaceLink(controller, request.value)
    if (!target) {
        // No workspace is open
        return BooleanResponse.create({ value: false })
    }

    try {
        return BooleanResponse.create({ value: fs.statSync(target.absolutePath).isFile() })
    } catch {
        return BooleanResponse.create({ value: false })
    }
}
