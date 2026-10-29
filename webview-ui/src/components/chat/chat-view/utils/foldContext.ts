import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import { apiFailureOf, supersededFailureIndexes } from "@shared/chat/failurePresentation"
import type { CodeExecutionPresentationV1 } from "@shared/code-execution-tools"
import { isTerminalRetryFailure } from "@shared/combineErrorRetryMessages"
import type { CommandStatus, UiMessage, UiSayGenerateExplanation, UiSayHook, UiSayTool } from "@shared/ExtensionMessage"
import { type ImageGenerationPresentationV1, parseImageGenerationPresentation } from "@shared/image-generation"
import type { LoadCapabilityPayload } from "@shared/load-capabilities"
import type { WebFetchPresentationV1, WebSearchPresentationV1 } from "@shared/web-tools"
import type { RequestRounds } from "./messageUtils"

/**
 * Facts the fold step needs that are not carried by the grouped rows.
 *
 * Built once per render from the full message array, so the fold step stays a
 * pure function of its rows and never re-derives grouping.
 */
export interface FoldContext {
    /** Rows whose request or compaction failed, by the shared failure-ownership rules. */
    readonly failedTs: ReadonlySet<number>
    /** Tool rows that own a pre-edit checkpoint the user checked out. */
    readonly checkedOutOwners: ReadonlySet<number>
    /** Request round of every message, indexed on the full transcript. */
    readonly rounds: RequestRounds
}

export function buildFoldContext(messages: readonly UiMessage[], rounds: RequestRounds): FoldContext {
    return { failedTs: failedRowTimestamps(messages), checkedOutOwners: checkedOutAttachmentOwners(messages), rounds }
}

/**
 * Failures the chat still draws.
 *
 * A request failure is either recorded on the request row or arrives as a
 * separate `api_req_failed` ask that belongs to the request it follows; the
 * backward walk hands each such ask to the request row reached next, the way
 * `supersededFailureIndexes` assigns ownership. Superseded failures are not
 * drawn, so they are left out.
 */
function failedRowTimestamps(messages: readonly UiMessage[]): ReadonlySet<number> {
    const superseded = supersededFailureIndexes(messages)
    const failed = new Set<number>()
    let requestFailureAhead = false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.type === "ask" && message.ask === "api_req_failed") requestFailureAhead = true
        const isRequest = message.say === "api_req_started"
        if (!superseded.has(index) && apiFailureOf(message, isRequest && requestFailureAhead)) failed.add(message.ts)
        if (isRequest) requestFailureAhead = false
    }
    return failed
}

function checkedOutAttachmentOwners(messages: readonly UiMessage[]): ReadonlySet<number> {
    const owners = new Set<number>()
    for (const [toolTs, checkpoints] of indexPreEditCheckpointAttachments(messages)) {
        if (checkpoints.some((checkpoint) => checkpoint.isCheckpointCheckedOut)) owners.add(toolTs)
    }
    return owners
}

/**
 * Whether a row is still running (`live`), ended in a failure (`failed`), or is
 * finished work (`settled`). Live and failed rows are never folded.
 *
 * This is the only owner of these rules. Each entry reads the same payload
 * fields, with the same precedence, as the renderer that draws the row.
 */
export type RowState = "live" | "failed" | "settled"

export function rowState(message: UiMessage, context: FoldContext): RowState {
    if (message.partial === true) return "live"
    if (context.failedTs.has(message.ts)) return "failed"

    if (message.type === "ask") {
        switch (message.ask) {
            case "api_req_failed":
            case "mistake_limit_reached":
                return "failed"
            case "command":
                return commandState(message)
            case "use_subagents":
                return "live"
            case "tool":
                return toolRowState(message)
            default:
                return "settled"
        }
    }

    switch (message.say) {
        case "error":
        case "diff_error":
        case "clineignore_error":
            return "failed"
        case "error_retry":
            // A transient retry notice is followed by the retried request; only an exhausted one stays failed.
            return isTerminalRetryFailure(message) ? "failed" : "settled"
        case "command":
            return commandState(message)
        case "hook_status":
            return hookState(message)
        case "generate_explanation":
            return explanationState(message)
        // Subagent progress lives in the activity projection, not in the row, so the row cannot prove it ended.
        case "subagent":
        case "use_subagents":
            return "live"
        case "tool":
            return toolRowState(message)
        default:
            return "settled"
    }
}

/** A status outside its declared union comes from newer or malformed data; keep such a row visible. */
function unknownStatus(_status: never): RowState {
    return "live"
}

function commandState(message: UiMessage): RowState {
    // CommandOutputRow draws a finished command with a non-zero exit code as failed.
    const exitedWithError = message.exitCode != null && message.exitCode !== 0
    const status: CommandStatus | undefined = message.commandStatus
    if (status === undefined) return exitedWithError ? "failed" : "settled"
    switch (status) {
        case "pending":
        case "running":
            return "live"
        case "failed":
        case "cancelled":
        case "interrupted":
            return "failed"
        case "completed":
        case "skipped":
            return exitedWithError ? "failed" : "settled"
        default:
            return unknownStatus(status)
    }
}

function hookState(message: UiMessage): RowState {
    const hook = parseJsonObject<UiSayHook>(message.text)
    if (!hook) return "settled"
    const status = hook.status
    switch (status) {
        case "running":
            return "live"
        case "failed":
        case "cancelled":
            return "failed"
        case "completed":
            return "settled"
        default:
            return unknownStatus(status)
    }
}

function explanationState(message: UiMessage): RowState {
    // ChatRow draws a row without a readable payload as still generating.
    const status: UiSayGenerateExplanation["status"] =
        parseJsonObject<UiSayGenerateExplanation>(message.text)?.status ?? "generating"
    switch (status) {
        case "generating":
            return "live"
        case "error":
            return "failed"
        case "complete":
            return "settled"
        default:
            return unknownStatus(status)
    }
}

/** File edits whose per-block errors are drawn by DiffEditRow. */
const FILE_EDIT_TOOLS = new Set<UiSayTool["tool"]>(["editedExistingFile", "newFileCreated"])

function toolRowState(message: UiMessage): RowState {
    const imageGeneration = message.imageGeneration
    const tool = parseJsonObject<UiSayTool>(message.text)
    if (!tool) return imageGeneration ? imageGenerationState(imageGeneration) : "settled"

    switch (tool.tool) {
        // A kill request's outcome is projected from the activity store, not written to the row.
        case "killCommand":
            return "live"
        case "summarizeTask":
            return tool.compactionStatus ? compactionState(tool.compactionStatus) : "settled"
        case "loadCapability":
            return loadCapabilityState(tool.loadCapability ?? (tool as unknown as LoadCapabilityPayload))
        case "generateImage": {
            const presentation = imageGeneration ?? parseImageGenerationPresentation(tool.imageGeneration)
            return presentation ? imageGenerationState(presentation) : "settled"
        }
    }

    if (tool.webFetch) return webToolState(tool.webFetch)
    if (tool.webSearch) return webToolState(tool.webSearch)
    if (tool.codeExecution) return codeExecutionState(tool.codeExecution)
    if (imageGeneration) return imageGenerationState(imageGeneration)
    if (FILE_EDIT_TOOLS.has(tool.tool) && tool.blockErrors?.some((error) => Boolean(error))) return "failed"
    return "settled"
}

function compactionState(status: NonNullable<UiSayTool["compactionStatus"]>): RowState {
    switch (status) {
        case "preparing":
        case "waiting":
        case "receiving":
        case "running":
        case "retrying":
            return "live"
        case "failed":
            return "failed"
        case "completed":
            return "settled"
        default:
            return unknownStatus(status)
    }
}

function loadCapabilityState(payload: LoadCapabilityPayload): RowState {
    const status = payload.status
    switch (status) {
        case "loading":
            return "live"
        case "failed":
            return "failed"
        case "completed":
            return "settled"
        default:
            return unknownStatus(status)
    }
}

function webToolState(presentation: WebFetchPresentationV1 | WebSearchPresentationV1): RowState {
    if (presentation.error) return "failed"
    const status = presentation.status
    switch (status) {
        case "running":
        case "deferred":
            return "live"
        case "failed":
            return "failed"
        case "completed":
            return "settled"
        default:
            return unknownStatus(status)
    }
}

function codeExecutionState(presentation: CodeExecutionPresentationV1): RowState {
    if (presentation.error) return "failed"
    const status = presentation.status
    switch (status) {
        case "running":
            return "live"
        case "failed":
            return "failed"
        case "completed":
            return "settled"
        default:
            return unknownStatus(status)
    }
}

function imageGenerationState(presentation: ImageGenerationPresentationV1): RowState {
    const status = presentation.status
    switch (status) {
        case "awaiting_approval":
        case "queued":
        case "started":
        case "preview":
            return "live"
        case "failed":
        case "rejected":
            return "failed"
        case "completed":
        case "cancelled":
            return "settled"
        default:
            return unknownStatus(status)
    }
}

function parseJsonObject<T>(text: string | undefined): T | undefined {
    if (!text) return undefined
    try {
        const value: unknown = JSON.parse(text)
        return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : undefined
    } catch {
        return undefined
    }
}
