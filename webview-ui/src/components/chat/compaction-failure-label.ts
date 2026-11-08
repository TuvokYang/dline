import type { CompactionFailureKind } from "@shared/context-compaction-failure"
import type { UiTranslator } from "@/i18n/messages"

/**
 * Message keys for the content-free compaction failure classifications.
 *
 * The key is resolved here and translated by the caller, so a rendered row keeps
 * the classification rather than a frozen sentence when the language changes.
 */
export type CompactionFailureMessageKey =
    | "chatRows.errors.compaction.emptyResponse"
    | "chatRows.errors.compaction.missingBlock"
    | "chatRows.errors.compaction.foreignToolCall"
    | "chatRows.errors.compaction.missingContext"
    | "chatRows.errors.compaction.emptyContext"
    | "chatRows.errors.compaction.unclosedContext"
    | "chatRows.errors.compaction.unclosedBlock"
    | "chatRows.errors.compaction.outputLimit"
    | "chatRows.errors.compaction.providerError"
    | "chatRows.errors.compaction.authorizationFailed"
    | "chatRows.errors.compaction.cancelled"

const COMPACTION_FAILURE_KEYS: Record<CompactionFailureKind, CompactionFailureMessageKey> = {
    empty_response: "chatRows.errors.compaction.emptyResponse",
    missing_block: "chatRows.errors.compaction.missingBlock",
    foreign_tool_call: "chatRows.errors.compaction.foreignToolCall",
    missing_context: "chatRows.errors.compaction.missingContext",
    empty_context: "chatRows.errors.compaction.emptyContext",
    unclosed_context: "chatRows.errors.compaction.unclosedContext",
    unclosed_block: "chatRows.errors.compaction.unclosedBlock",
    output_limit: "chatRows.errors.compaction.outputLimit",
    provider_error: "chatRows.errors.compaction.providerError",
    authorization_failed: "chatRows.errors.compaction.authorizationFailed",
    cancelled: "chatRows.errors.compaction.cancelled",
}

/**
 * Select the stable message key for a compaction failure classification.
 *
 * @param kind Content-free failure classification carried by the compaction card.
 * @returns The message key to translate, or undefined when the card has no classified failure.
 */
export function compactionFailureKey(kind: CompactionFailureKind | undefined): CompactionFailureMessageKey | undefined {
    return kind ? COMPACTION_FAILURE_KEYS[kind] : undefined
}

/**
 * Describe why the latest compaction attempt was rejected.
 *
 * @param kind Content-free failure classification carried by the compaction card.
 * @param t Translator belonging to the rendering surface.
 * @returns A short localized reason, or undefined when the card has no classified failure.
 */
export function describeCompactionFailure(kind: CompactionFailureKind | undefined, t: UiTranslator): string | undefined {
    const key = compactionFailureKey(kind)
    return key ? t(key) : undefined
}
