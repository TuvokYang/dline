import {
    isActiveEntity,
    isContentNode,
    isMentionNode,
    isSlashCommandNode,
    type SemanticInputDocument,
    type SemanticInputNode,
} from "@shared/input-semantics/document"
import type { ProfileDisplayState } from "./task-header/profileDisplayState"

const REPORT_BUG_COMMAND_ID = "command.report_bug"

function isReportBugCommand(node: SemanticInputNode): boolean {
    return isSlashCommandNode(node) && isActiveEntity(node) && node.commandId === REPORT_BUG_COMMAND_ID
}

export function isReportBugSemanticDocument(document: SemanticInputDocument | undefined): boolean {
    return Boolean(document?.nodes.some(isReportBugCommand))
}

/**
 * The report details the user wrote around the command.
 *
 * The command is dropped by node identity rather than by re-matching its
 * spelling in the raw text, so every catalog spelling (`/reportbug`,
 * `/cmd:reportbug`, an alias) yields the same details. Other entities keep the
 * text the user saw; the local fallback uploads no resources, so image and
 * file nodes contribute nothing.
 */
export function reportBugDetails(document: SemanticInputDocument): string {
    return document.nodes
        .map((node) => {
            if (isReportBugCommand(node)) return ""
            if (isContentNode(node)) return node.text
            if (isSlashCommandNode(node) || isMentionNode(node)) return node.sourceText
            return ""
        })
        .join("")
        .trim()
}

export function shouldUseLocalReportBugFallback(profile: ProfileDisplayState, interactionKind: string | undefined): boolean {
    if (interactionKind === "profile_failure" || interactionKind === "error_retry") return true
    return profile.kind === "load_error" || profile.kind === "create" || profile.kind === "select"
}
