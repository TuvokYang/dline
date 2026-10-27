import type { ExplicitInstructionDeclaration } from "@core/task/explicit-instructions/types"
import { DlineDefaultTool } from "@shared/tools"
import type { ConversationViewEntry } from "../executors/provider/service/JournalConversationView"

interface PendingReportBug {
    readonly declaration: ExplicitInstructionDeclaration
    readonly payloadRef: string
}

/** Calls after which a report intent is finished: the report itself, or the end of the work. */
const INTENT_CLOSING_TOOLS: ReadonlySet<string> = new Set([DlineDefaultTool.REPORT_BUG, DlineDefaultTool.ATTEMPT])

/** Whether one durable conversation entry records a call that finishes the report intent. */
function closesReportIntent(entry: ConversationViewEntry): boolean {
    return entry.messages.some(
        (message) =>
            message.role === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === "tool_use" && INTENT_CLOSING_TOOLS.has(block.name)),
    )
}

/**
 * The latest admitted /reportbug intent that nothing has finished yet.
 *
 * The source must be a declaration persisted by semantic admission; rendered prompt text
 * is never trusted. A report_bug call closes the intent, and so does a completion: work
 * that ended without a report abandoned it, and keeping it open would keep telling every
 * later turn that a report is pending. Questions and the user's answers leave it open.
 */
function pendingReportIntent(entries: readonly ConversationViewEntry[]): PendingReportBug | undefined {
    let pending: PendingReportBug | undefined
    for (const entry of entries) {
        for (const declaration of entry.explicitInstructions ?? []) {
            if (declaration.type !== "report_bug" || declaration.targetTool !== DlineDefaultTool.REPORT_BUG) continue
            pending = { declaration, payloadRef: entry.entry.payloadRef }
        }
        if (closesReportIntent(entry)) pending = undefined
    }
    return pending
}

/** Derive the current turn's one-shot report_bug authority from an unfinished durable report intent. */
export function deriveReportBugContinuationFromEntries(
    entries: readonly ConversationViewEntry[],
): ExplicitInstructionDeclaration | undefined {
    const pending = pendingReportIntent(entries)
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
