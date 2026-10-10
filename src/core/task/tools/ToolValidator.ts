import type { ToolParamName, ToolUse } from "@core/assistant-message"
import { AGENT_IGNORE_FILE, type IgnoreController, type IgnorePermission } from "@core/ignore/IgnoreController"

export type ValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Lightweight validator used by new tool handlers.
 * The legacy ToolExecutor switch remains unchanged and does not depend on this.
 */
export class ToolValidator {
    constructor(private readonly ignoreController: IgnoreController) {}

    /**
     * Verifies required parameters exist on the tool block.
     * Returns a message suitable for displaying in an error.
     */
    assertRequiredParams(block: ToolUse, ...params: ToolParamName[]): ValidationResult {
        for (const p of params) {
            // params are stored under block.params using their tag name
            const val = (block as any)?.params?.[p]
            if (val === undefined || val === null || String(val).trim() === "") {
                return { ok: false, error: `Missing required parameter '${p}' for tool '${block.name}'.` }
            }
        }
        return { ok: true }
    }

    /**
     * Verify that a path may be opened.
     *
     * Only agent-authored rules apply: a path excluded from version control, or
     * living under a generated directory, is still readable. Callers should pass
     * a repo-relative (workspace-relative) path.
     */
    checkClineIgnorePath(relPath: string): ValidationResult {
        return this.checkPermission(relPath, "read")
    }

    /**
     * Verify that a path may be modified.
     *
     * Write is a separate permission, so a project can expose a directory for
     * reading while keeping it read-only, for example vendored dependencies or
     * generated sources.
     */
    checkWritePath(relPath: string): ValidationResult {
        return this.checkPermission(relPath, "write")
    }

    private checkPermission(relPath: string, permission: IgnorePermission): ValidationResult {
        if (this.ignoreController.validateAccess(relPath, permission)) return { ok: true }
        const action = permission === "write" ? "Writing to" : "Access to"
        return {
            ok: false,
            error: `${action} path '${relPath}' is blocked by ${AGENT_IGNORE_FILE} settings.`,
        }
    }
}
