import type { ExplicitInstructionDeclaration } from "@core/task/explicit-instructions/types"
import { DlineDefaultTool } from "@shared/tools"
import type { ConversationViewEntry } from "../executors/provider/service/JournalConversationView"

interface PendingReportBug {
    readonly declaration: ExplicitInstructionDeclaration
    readonly payloadRef: string
}

/** Whether one durable conversation entry records an actual report_bug invocation. */
function containsReportBugCall(entry: ConversationViewEntry): boolean {
    return entry.messages.some(
        (message) =>
            message.role === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === "tool_use" && block.name === DlineDefaultTool.REPORT_BUG),
    )
}

/**
 * Derive the current turn's one-shot authority from an unfinished durable report intent.
 *
 * The source must be a declaration persisted by semantic admission; rendered prompt text
 * is never trusted. An actual report_bug tool call closes the latest intent, while ordinary
 * assistant questions and user answers leave it pending for the next Provider turn.
 */
export function deriveReportBugContinuationFromEntries(
    entries: readonly ConversationViewEntry[],
): ExplicitInstructionDeclaration | undefined {
    let pending: PendingReportBug | undefined

    for (const entry of entries) {
        for (const declaration of entry.explicitInstructions ?? []) {
            if (declaration.type !== "report_bug" || declaration.targetTool !== DlineDefaultTool.REPORT_BUG) continue
            pending = { declaration, payloadRef: entry.entry.payloadRef }
        }
        if (containsReportBugCall(entry)) pending = undefined
    }

    if (!pending) return undefined
    return {
        type: "report_bug",
        source: "internal_continuation",
        targetTool: DlineDefaultTool.REPORT_BUG,
        operationId: pending.declaration.operationId ?? `report-bug-continuation:${pending.payloadRef}`,
        metadata: {
            ...(pending.declaration.metadata ?? {}),
            sourcePayloadRef: pending.payloadRef,
        },
    }
}
