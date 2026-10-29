/**
 * Shared presentation contract for provider-hosted code execution.
 *
 * A provider runs the sandbox on its own infrastructure, so the only record of
 * what actually ran is what the provider streams back. These normalizers turn
 * that untrusted payload into a stable shape the UI can render, which is what
 * makes a failed run diagnosable instead of just "failed".
 */

export type CodeExecutionPresentationStatus = "running" | "completed" | "failed"

export interface CodeExecutionSourcePresentation {
    id: string
    label: string
    execution: "hosted"
    provider?: string
}

/**
 * One sandbox invocation, discriminated by the facet the provider used.
 *
 * A single declared `code_execution` tool exposes several facets to the model
 * (running code, running a shell command, editing a file), and each reports a
 * differently shaped payload. `unknown` keeps an unrecognized facet visible
 * rather than silently dropping it.
 */
export type HostedCodeExecutionOperation =
    | { type: "code"; code: string }
    | { type: "bash"; command: string }
    | { type: "text_editor"; command: string; path?: string }
    | { type: "unknown"; providerType?: string }

/** Captured stream from one sandbox invocation. */
export interface CodeExecutionOutputPresentation {
    stdout?: string
    stderr?: string
    returnCode?: number
    /** File names the sandbox produced, when the provider reports them. */
    files?: string[]
}

export interface CodeExecutionPresentationV1 {
    schemaVersion: 1
    status: CodeExecutionPresentationStatus
    source?: CodeExecutionSourcePresentation
    operation?: HostedCodeExecutionOperation
    output?: CodeExecutionOutputPresentation
    /** Provider error code such as `too_many_requests`, when one is reported. */
    errorCode?: string
    error?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/** Preserve interior whitespace: source code and shell output are layout-sensitive. */
function nonEmptyRawString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function finiteInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) ? value : undefined
}

function fileNames(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((entry) => {
        const name = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.file_id) ?? nonEmptyString(asRecord(entry)?.name)
        return name ? [name] : []
    })
}

/**
 * Normalize a provider-native sandbox invocation into a stable shared operation.
 *
 * Accepts both the raw input object and an `{ input: ... }` envelope, because
 * the value arrives from different points of the stream depending on whether it
 * was captured at block start or assembled from streamed JSON deltas.
 */
export function normalizeHostedCodeExecutionOperation(value: unknown): HostedCodeExecutionOperation {
    const record = asRecord(value)
    const input = asRecord(record?.input) ?? record
    if (!input) return { type: "unknown" }

    const providerType = nonEmptyString(input.type)

    const code = nonEmptyRawString(input.code)
    if (code) return { type: "code", code }

    // A text editor call is identified by carrying a path alongside its command,
    // which is what separates it from a plain shell invocation.
    const path = nonEmptyString(input.path) ?? nonEmptyString(input.file_path)
    const command = nonEmptyString(input.command)
    if (path) {
        return { type: "text_editor", command: command ?? "view", path }
    }
    if (command) return { type: "bash", command }

    return {
        type: "unknown",
        ...(providerType ? { providerType } : {}),
    }
}

/** Short human-readable label for one sandbox operation. */
export function describeCodeExecutionOperation(operation: HostedCodeExecutionOperation | undefined): string | undefined {
    switch (operation?.type) {
        case "code":
            return operation.code
        case "bash":
            return operation.command
        case "text_editor":
            return operation.path ? `${operation.command} ${operation.path}` : operation.command
        default:
            return undefined
    }
}

/** Normalize a provider-native sandbox result before it crosses the UI message boundary. */
export function normalizeCodeExecutionOutput(result: unknown): CodeExecutionOutputPresentation | undefined {
    const record = asRecord(result)
    const content = asRecord(record?.content) ?? record
    if (!content) return undefined

    const stdout = nonEmptyRawString(content.stdout)
    const stderr = nonEmptyRawString(content.stderr)
    const returnCode = finiteInteger(content.return_code) ?? finiteInteger(content.returnCode)
    const files = fileNames(content.content ?? content.files)

    if (stdout === undefined && stderr === undefined && returnCode === undefined && files.length === 0) {
        return undefined
    }

    return {
        ...(stdout === undefined ? {} : { stdout }),
        ...(stderr === undefined ? {} : { stderr }),
        ...(returnCode === undefined ? {} : { returnCode }),
        ...(files.length > 0 ? { files } : {}),
    }
}

/**
 * Extract a provider error code such as `too_many_requests` or `unavailable`.
 *
 * The code is the actionable part of a sandbox failure, so it is surfaced
 * separately from any prose the provider happens to include.
 */
export function normalizeCodeExecutionErrorCode(error: unknown): string | undefined {
    const record = asRecord(error)
    const content = asRecord(record?.content) ?? record
    return nonEmptyString(content?.error_code) ?? nonEmptyString(record?.error_code)
}
