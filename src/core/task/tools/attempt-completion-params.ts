import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"

/** Normalize the legacy attempt_completion response field to the canonical result field. */
export function canonicalizeAttemptCompletionParams(block: ToolUse): boolean {
    if (block.name === DlineDefaultTool.ATTEMPT && !block.params?.result && typeof block.params?.response === "string") {
        block.params.result = block.params.response
        return true
    }

    return false
}
