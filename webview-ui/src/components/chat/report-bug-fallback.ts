import { isActiveEntity, isSlashCommandNode, type SemanticInputDocument } from "@shared/input-semantics/document"
import type { ProfileDisplayState } from "./task-header/profileDisplayState"

const REPORT_BUG_COMMAND_ID = "command.report_bug"

export function isReportBugSemanticDocument(document: SemanticInputDocument | undefined): boolean {
    return Boolean(
        document?.nodes.some(
            (node) => isSlashCommandNode(node) && isActiveEntity(node) && node.commandId === REPORT_BUG_COMMAND_ID,
        ),
    )
}

export function shouldUseLocalReportBugFallback(profile: ProfileDisplayState, interactionKind: string | undefined): boolean {
    if (interactionKind === "profile_failure" || interactionKind === "error_retry") return true
    return profile.kind === "load_error" || profile.kind === "create" || profile.kind === "select"
}
