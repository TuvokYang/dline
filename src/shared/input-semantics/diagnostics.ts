/**
 * Machine-readable diagnostics for semantic input and its resources.
 *
 * Every diagnostic names the document and, when the problem is local, the
 * entity or resource it concerns, so the composer can mark the exact node and
 * keep the draft editable instead of reporting that parsing failed.
 */

export const SEMANTIC_INPUT_DIAGNOSTIC_CODES = [
    "semantic_input_schema_unsupported",
    "semantic_input_parser_unsupported",
    "semantic_input_catalog_stale",
    "semantic_input_node_invalid",
    "semantic_input_source_mismatch",
    "semantic_input_command_unknown",
    "semantic_input_command_disabled",
    "semantic_input_mention_denied",
    "semantic_input_lifecycle_barrier_invalid",
    "semantic_input_resource_missing",
    "semantic_input_resource_invalid",
    "semantic_input_resource_changed",
    "semantic_input_resource_invalid_mime",
    "semantic_input_resource_too_large",
    "semantic_input_resource_stage_failed",
    "semantic_input_resource_adopt_failed",
    "semantic_input_resource_copy_failed",
] as const

export type SemanticInputDiagnosticCode = (typeof SEMANTIC_INPUT_DIAGNOSTIC_CODES)[number]

const DIAGNOSTIC_CODE_SET: ReadonlySet<string> = new Set(SEMANTIC_INPUT_DIAGNOSTIC_CODES)

export function isSemanticInputDiagnosticCode(value: string): value is SemanticInputDiagnosticCode {
    return DIAGNOSTIC_CODE_SET.has(value)
}

/** Type-level marker that only {@link semanticInputDiagnostic} can produce; it has no runtime value. */
declare const sanitizedDiagnostic: unique symbol

export interface SemanticInputDiagnostic {
    readonly code: SemanticInputDiagnosticCode
    /** English, actionable, and free of file contents, payloads or credentials. */
    readonly message: string
    readonly documentId: string
    readonly entityId?: string
    readonly resourceId?: string
    /**
     * Proof that the message passed through the sanitizer. An object literal
     * cannot satisfy it, so every construction site goes through the factory.
     */
    readonly [sanitizedDiagnostic]: true
}

/** The node a diagnostic points at. */
export interface SemanticInputDiagnosticLocator {
    readonly documentId: string
    readonly entityId?: string
    readonly resourceId?: string
}

const MAX_DIAGNOSTIC_TEXT_LENGTH = 500
const REDACTED_PATH = "[path]"
const REDACTED = "[redacted]"
// The media type is optional: "data:,payload" and "data:;base64,payload" are valid data URLs.
const DATA_URL = /data:(?:[\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*,[^\s"')]*/gi
const FILE_URL = /\bfile:\/\/[^\s"'<>]*/gi
const AUTHORIZATION_CREDENTIAL = /\b(Bearer|Basic)\s+[\w.~+/-]+=*/gi
const PROVIDER_API_KEY = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g
// A directory segment may contain single spaces between words ("Alice Smith")
// because it must end at a separator; the final segment stops at whitespace.
// Clause punctuation ends a segment, so one match never spans two paths.
const UNC_PATH = /\\\\[^\s\\/"'<>|;,]+[\\/](?:[^\\/\s"'<>|:*?;,]+(?: [^\\/\s"'<>|:*?;,]+)*[\\/])*[^\s\\/"'<>|:*?;,]*/g
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|:*?;,]+(?: [^\\/\s"'<>|:*?;,]+)*[\\/])*[^\s\\/"'<>|:*?;,]*/g
// Well-known roots hold user names and other prose-like segments, so spaces are allowed there.
const POSIX_HOME_PATH =
    /(?<![\w.:/])\/(?:home|Users|root|tmp|var|private|mnt|media|opt|srv|Volumes)\/(?:[^/\s"'<>|;,]+(?: [^/\s"'<>|;,]+)*\/)*[^\s/"'<>|;,]*/g
// Two or more segments, so a command name such as "/compact" stays readable.
const POSIX_ABSOLUTE_PATH = /(?<![\w.:/])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g
// A file directly under the root, recognized by its extension.
const POSIX_ROOT_FILE = /(?<![\w.:/])\/[\w@~+-][\w.@~+-]*\.[A-Za-z0-9]{1,10}\b/g
const ENCODED_PAYLOAD = /[A-Za-z0-9+/_-]{64,}={0,2}/g

/**
 * Remove content and credentials from diagnostic wording.
 *
 * Diagnostics travel to the Webview, logs and telemetry, so they must never
 * carry the image data, local paths or tokens of the input they describe.
 * Construction sites should name resources by display name or ID; this is the
 * defense in depth for the text that still reaches a message.
 */
export function sanitizeDiagnosticText(text: string): string {
    const sanitized = text
        .replace(DATA_URL, "[data-url]")
        .replace(FILE_URL, REDACTED_PATH)
        .replace(AUTHORIZATION_CREDENTIAL, `$1 ${REDACTED}`)
        .replace(PROVIDER_API_KEY, REDACTED)
        .replace(UNC_PATH, REDACTED_PATH)
        .replace(WINDOWS_ABSOLUTE_PATH, REDACTED_PATH)
        .replace(POSIX_HOME_PATH, REDACTED_PATH)
        .replace(POSIX_ABSOLUTE_PATH, REDACTED_PATH)
        .replace(POSIX_ROOT_FILE, REDACTED_PATH)
        .replace(ENCODED_PAYLOAD, REDACTED)
    return sanitized.length > MAX_DIAGNOSTIC_TEXT_LENGTH ? `${sanitized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 3)}...` : sanitized
}

/** Build one diagnostic whose message is already safe to show and log. */
export function semanticInputDiagnostic(
    code: SemanticInputDiagnosticCode,
    message: string,
    locator: SemanticInputDiagnosticLocator,
): SemanticInputDiagnostic {
    return {
        code,
        message: sanitizeDiagnosticText(message),
        documentId: locator.documentId,
        ...(locator.entityId ? { entityId: locator.entityId } : {}),
        ...(locator.resourceId ? { resourceId: locator.resourceId } : {}),
    } as SemanticInputDiagnostic
}
