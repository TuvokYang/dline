import type { UiMessage } from "../ExtensionMessage"
import { supersededFailureIndexes } from "./failurePresentation"
import { isAttachedMcpResponse } from "./mcpResponseRows"

/**
 * The single rule for which stored chat rows the chat draws.
 *
 * The webview applies it before grouping rows, and the extension applies it to
 * tell whether two checkpoints would show next to each other. Keeping one rule
 * for both means a checkpoint is never kept or dropped on the strength of a row
 * the user cannot see.
 */
export function filterDrawnMessages(messages: readonly UiMessage[]): UiMessage[] {
    const attachedCheckpointTimestamps = new Set(
        Array.from(indexPreEditCheckpointAttachments(messages).values(), (checkpoints) =>
            checkpoints.map((message) => message.ts),
        ).flat(),
    )
    const retriedFailures = supersededFailureIndexes(messages)
    return messages.filter((message, index, arr) => {
        // A failure a later attempt of the same work answered stays recorded but is not drawn.
        if (retriedFailures.has(index)) return false
        const hasNoVisibleContent = !message.text?.trim() && !message.images?.length && !message.files?.length
        if (message.say === "checkpoint_created" && attachedCheckpointTimestamps.has(message.ts)) {
            // The restore point renders with its owning tool card. If that card is
            // outside this paged window, the index omits it and this row remains.
            return false
        }
        // Older runtimes persisted empty intake and turn-ending presentation rows.
        // Keep them as recovery evidence, but never allocate a virtualized item for
        // a content-only row that cannot render any user-visible content.
        if (hasNoVisibleContent && message.type === "say") {
            switch (message.say) {
                case "user_feedback":
                case "text":
                case "qna_respond":
                case "completion_result":
                    return false
            }
        }
        switch (message.ask) {
            case "completion_result":
                // don't show a chat row for a completion_result ask without text. This specific type of message only occurs if cline wants to execute a command as part of its completion result, in which case we interject the completion_result tool with the execute_command tool.
                if (hasNoVisibleContent) {
                    return false
                }
                break
            case "generate_report":
            case "status_acknowledgment":
                if (hasNoVisibleContent) return false
                break
            case "api_req_failed": // this message is used to update the latest api_req_started that the request failed
            case "resume_task":
            case "resume_completed_task":
                return false
            case "use_subagents":
            case "spawn_task":
                if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
                    return false
                }
                break
        }
        // Generic partial dedup based on ts: hide stale partials when a completed
        // version or a newer partial with the same ts is present.
        if (message.partial === true) {
            const hasCompleteWithSameTs = arr.some((m, i) => i !== index && m.ts === message.ts && m.partial !== true)
            const hasNewerDuplicatePartial = arr.slice(index + 1).some((m) => m.ts === message.ts && m.partial === true)
            if (hasCompleteWithSameTs || hasNewerDuplicatePartial) return false
        }

        switch (message.say) {
            case "api_req_finished": // combineApiRequests removes this from modifiedMessages anyways
            case "api_req_retried": // this message is used to update the latest api_req_started that the request was retried
            case "deleted_api_reqs": // aggregated api_req metrics from deleted messages
            case "subagent_usage": // aggregated subagent usage metrics for task-level accounting
            case "task_progress": // task progress messages are displayed in TaskHeader, not in main chat
            case "partial_tool_result": // invisible tool-result snapshot for resume replay — not rendered
            case "state_snapshot": // phase lifecycle snapshot — backend-internal, not user-visible
                return false
            // NOTE: reasoning passes through to be included in tool groups
            case "api_req_started": {
                // api_req_started rows only render visible content for failures.
                // Reasoning has its own standalone ChatRows, and a cancelled request
                // has nothing of its own to show: keeping it only re-rendered that
                // reasoning a second time under the request. Filter out unless the
                // request failed.
                try {
                    const info = JSON.parse(message.text || "{}")
                    if (info.streamingFailedMessage) {
                        break // keep - has error content
                    }
                } catch {
                    break // keep on parse error to be safe
                }
                // Keep this row if its own api_req_failed needs it as an error carrier.
                // api_req_failed messages are filtered out and are only used to update the
                // latest api_req_started row. If we drop the carrier row, the error is invisible.
                if (isFollowedByOwnFailure(arr, index)) {
                    break
                }
                return false
            }
            case "text":
                // Assistant prose stays in the conversation, not in the tool-owned chat surface.
                // Apply the same rule to partial and final frames so a Respond row never flashes then disappears.
                return Boolean(message.images?.length || message.files?.length)
            case "mcp_server_request_started":
                return false
            case "mcp_server_response":
                if (isAttachedMcpResponse(arr, index)) return false
                break
            case "use_subagents":
                if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
                    return false
                }
                break
        }
        return true
    })
}

/**
 * Whether the chat draws no row strictly between the rows at `fromTs` and `toTs`.
 *
 * The whole list is filtered rather than the rows in between, because whether a
 * row there is drawn can depend on rows after it: a failed request is hidden
 * once its retry exists.
 */
export function drawsNothingBetween(messages: readonly UiMessage[], fromTs: number, toTs: number): boolean {
    return !filterDrawnMessages(messages).some((message) => message.ts > fromTs && message.ts < toTs)
}

/**
 * Index pre-edit checkpoints whose unique source tool card is present in this loaded window.
 *
 * Both filtering and rendering consume this map, so a checkpoint cannot be hidden
 * by a looser rule than the one that attaches it. Any missing or ambiguous owner
 * leaves the restore point standalone.
 */
export function indexPreEditCheckpointAttachments(messages: readonly UiMessage[]): ReadonlyMap<number, UiMessage[]> {
    const toolCandidates = new Map<number, UiMessage[]>()
    for (const message of messages) {
        if (message.ask !== "tool" && message.say !== "tool") continue
        const candidates = toolCandidates.get(message.ts) ?? []
        candidates.push(message)
        toolCandidates.set(message.ts, candidates)
    }

    const ownerTimestamps = new Set<number>()
    for (const [toolTs, candidates] of toolCandidates) {
        if (resolveToolPresentation(candidates)) ownerTimestamps.add(toolTs)
    }

    const checkpoints = new Map<number, UiMessage[]>()
    for (const message of messages) {
        const source = message.say === "checkpoint_created" ? message.checkpointSource : undefined
        if (source?.kind !== "pre_edit" || !ownerTimestamps.has(source.toolTs)) continue
        const attached = checkpoints.get(source.toolTs) ?? []
        attached.push(message)
        checkpoints.set(source.toolTs, attached)
    }
    return checkpoints
}

/** Select one visible tool presentation from same-ts partial/final updates; ambiguity stays standalone. */
function resolveToolPresentation(candidates: readonly UiMessage[]): UiMessage | undefined {
    const complete = candidates.filter((candidate) => candidate.partial !== true)
    if (complete.length === 1) return complete[0]
    if (complete.length > 1) return undefined
    return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * Whether an api_req_failed follows this request before the next request starts.
 * A failure belongs to the request it follows; scanning past the next request
 * kept every earlier request visible once any later request failed.
 */
function isFollowedByOwnFailure(messages: readonly UiMessage[], requestIndex: number): boolean {
    for (let i = requestIndex + 1; i < messages.length; i++) {
        const candidate = messages[i]
        if (candidate.say === "api_req_started") {
            return false
        }
        if (candidate.ask === "api_req_failed") {
            return true
        }
    }
    return false
}
