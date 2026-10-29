import { type SemanticInputDiagnosticCode, sanitizeDiagnosticText } from "@shared/input-semantics/diagnostics"

/** The diagnostic codes a resource operation can fail with; admission reuses them unchanged. */
export type InputResourceFailureCode = Extract<SemanticInputDiagnosticCode, `semantic_input_resource_${string}`>

/**
 * Why one input resource operation failed.
 *
 * The store reports failures as values rather than exceptions so every caller
 * (Host RPC, admission, adoption) has to decide what the user sees. The message
 * names the resource by display name or ID only and is sanitized on
 * construction, because it travels to the Webview, logs and telemetry. The
 * store has no document context; admission adds the document and entity
 * locator when it turns a failure into a diagnostic.
 */
export interface InputResourceFailure {
    readonly code: InputResourceFailureCode
    readonly message: string
    readonly resourceId?: string
}

export type InputResourceResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly failure: InputResourceFailure }

export function resourceSucceeded<T>(value: T): InputResourceResult<T> {
    return { ok: true, value }
}

export function resourceFailed<T = never>(
    code: InputResourceFailureCode,
    message: string,
    resourceId?: string,
): InputResourceResult<T> {
    return {
        ok: false,
        failure: { code, message: sanitizeDiagnosticText(message), ...(resourceId ? { resourceId } : {}) },
    }
}

/** Errno code of a filesystem error, safe to show because it carries no path. */
export function errnoOf(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown error"
}
