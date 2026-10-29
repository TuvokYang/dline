import { getPrompt, renderPrompt } from "@core/prompts/i18n"

/** Structured facts that explain why a task is resuming. */
export interface ResumeProvenance {
    readonly session: "restored_after_close"
}

const RESTORED_PROVENANCE: ResumeProvenance = {
    session: "restored_after_close",
}

/** Return the canonical facts for a restored task session. */
export function getRestoredResumeProvenance(): ResumeProvenance {
    return RESTORED_PROVENANCE
}

/** Project restored-session facts for the Resume interaction UI. */
export function createResumeInteractionPresentation(): string {
    return getPrompt("resumeProvenance", "interactionPresentation")
}

/** Project a provider-compatible synthetic result without guessing execution success or failure. */
export function createMissingToolResultMessage(toolName: string): string {
    return renderPrompt("resumeProvenance", "missingToolResult", { TOOL_NAME: toolName })
}

/**
 * The submission context a resumed round carries, or nothing when it is not a resume.
 *
 * Only a restored session has provenance to state. A retry after a failed round
 * happens inside the same live session, so claiming it was restored would be a
 * fabricated fact. The returned text is submission context rather than user
 * text: the materializer appends it to what the user typed, so the row the chat
 * shows stays exactly the user's own words.
 */
export function createResumeSubmissionContext(dialogKind: string): string | undefined {
    return dialogKind === "resume" ? createResumeInteractionPresentation() : undefined
}
