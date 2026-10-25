import * as path from "node:path"
import type { ApiHandler, buildApiHandler } from "@core/api"
import { recordProviderAdapterInput, recordProviderAdapterOutput } from "@core/api/debug/api-conversation-log"
import {
    disableWebFetchRoute,
    disableWebSearchRoute,
    localizeHostedWebRoutes,
    type WebSearchRoutingPlan,
} from "@core/api/server-tools"
import { createIdentityFactory, type IdentityFactory } from "@core/api/transform/block-identity"
import type { ApiProviderStreamChunk, ApiStopReason } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { ApiUsageAccumulator } from "@core/api/transform/usage-accumulator"
import { declaredAnthropicHostedToolNames } from "@core/api/utils/messages_api_support"
import { parseAssistantMessage, ToolUse } from "@core/assistant-message"
import { discoverAvailableSkills } from "@core/context/instructions/user-instructions/skills"
import { createImageProfileResolverForProfile } from "@core/image-generation/runtime"
import { formatResponse } from "@core/prompts/responses"
import { getSystemPrompt, type SystemPromptContext } from "@core/prompts/system-prompt"
import {
    buildTurnFailureFeedback,
    ConsecutiveTurnFailures,
    classifyToollessTurn,
    describeTurnFailure,
    type TurnFailure,
    type TurnFailureKind,
} from "@core/prompts/turn-diagnosis"
import { isRetryableProviderError } from "@core/task/auto-retry"
import { resolveRequestWebSearchRoutingPlan } from "@core/task/RequestApiScope"
import { StreamResponseHandler } from "@core/task/StreamResponseHandler"
import { DEFAULT_API_PROVIDER } from "@shared/api"
import {
    ClineAssistantContent,
    ClineAssistantToolUseBlock,
    ClineStorageMessage,
    ClineTextContentBlock,
    ClineUserContent,
    projectInternalMessagesForProvider,
} from "@shared/messages"
import { splitResumedHostedResults } from "@shared/messages/hosted-tool-deferral"
import { type ProviderTelemetryRole, providerTelemetryRoleForSubagent } from "@shared/provider-attempt-observer"
import { resolvePromptProfile } from "@shared/resolve-prompt-profile"
import { Logger } from "@shared/services/Logger"
import { ClineTool, DlineDefaultTool } from "@shared/tools"
import { ContextManager } from "@/core/context/context-management/ContextManager"
import { ContextBudgetLedger } from "@/core/context/context-management/context-budget-ledger"
import { checkContextWindowExceededError } from "@/core/context/context-management/context-error-handling"
import { DEFAULT_TOKEN_PER_BYTE } from "@/core/context/context-management/context-window-projection"
import {
    computeCompactTrigger,
    computeSummarizeBudget,
    getContextWindowInfo,
    resolveConfiguredContextWindow,
    shouldCompactProjectedUsage,
} from "@/core/context/context-management/context-window-utils"
import { HostRegistryInfo } from "@/registry"
import { boundToolText, MAX_TOOL_RESULT_TEXT_BYTES } from "@/shared/content-limits"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { calculateApiCostAnthropic } from "@/utils/cost"
import { isNativeToolCallingConfig, isNextGenModelFamily } from "@/utils/model-utils"
import { canonicalizeAttemptCompletionParams } from "../attempt-completion-params"
import { partitionDeferredHostedCalls } from "../deferred-hosted-rows"
import { type DeferredServerToolCall, ServerToolLifecycle } from "../ServerToolLifecycle"
import { DefaultToolHandlerState, type ToolHandlerState } from "../state/ToolHandlerState"
import { normalizeObservedToolExecutionResult } from "../ToolExecutionResult"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { resolveToolResultBudget } from "../utils/tool-result-budget"
import type { AgentBaseConfig } from "./AgentConfigLoader"
import { SUBAGENT_COMPLETION_CONTRACT, SubagentBuilder } from "./SubagentBuilder"
import { buildContextBudgetSection, resolveFinalResultTokens } from "./SubagentContextBudget"
import { buildContextUsageSection, buildFinishReminder, exceedsContextConvergenceThreshold } from "./SubagentConvergenceGate"
import type { SubagentFinishReason, SubagentProgressUpdate, SubagentRunStats } from "./SubagentExecutor"
import {
    buildSubagentOutputBudgetPrompt,
    resolveSubagentOutputBudget,
    truncateTextToSubagentOutputBudget,
} from "./SubagentOutputBudget"
import { SubagentProseStream } from "./SubagentProseStream"
import { type FrozenSubagentRoundContext, SubagentRoundContextProjection } from "./SubagentRoundContextProjection"

/**
 * Failed responses in a row after which a run stops with an error.
 *
 * Empty, reasoning-only, text-only and malformed responses, empty completions
 * and ignored finish orders all count against this one limit, and any tool that
 * executes successfully clears it. Separate per-kind limits let a run spin
 * indefinitely by alternating between failure kinds.
 */
const MAX_CONSECUTIVE_TURN_FAILURES = 5
/**
 * How many times one run may hand a hosted-tool stream failure back to the model.
 *
 * Recovery returns control to the subagent instead of ending the run, so it needs
 * a ceiling: a provider failing on every attempt would otherwise loop until the
 * turn budget ran out.
 */
const MAX_HOSTED_SERVER_TOOL_RECOVERIES = 2
/**
 * Reasons a hosted call is force-closed. They stay tool-neutral because one
 * lifecycle carries both web search and code execution, and a single
 * `finalizeOpen` may close several calls of different tools at once.
 */
const HOSTED_SERVER_TOOL_STREAM_FAILED_REASON = "Provider stream failed before this hosted tool call returned a result."
const HOSTED_SERVER_TOOL_STREAM_ENDED_REASON = "Provider stream ended before this hosted tool call returned a result."
const HOSTED_SERVER_TOOL_CANCELLED_REASON = "Subagent run cancelled before this hosted tool call returned a result."
const HOSTED_SERVER_TOOL_DEFERRED_ABANDONED_REASON =
    "The provider never ran this deferred hosted call: no later request of the subagent could resume it."
const INITIAL_STREAM_RETRY_DELAYS_MS = [5_000, 8_000, 11_000, 14_000, 17_000] as const
const MAX_INITIAL_STREAM_ATTEMPTS = INITIAL_STREAM_RETRY_DELAYS_MS.length + 1

export interface SubagentRunnerOptions {
    /** Keep ordinary subagents coupled to parent Task cancellation unless an explicit Activity owns their lifecycle. */
    inheritTaskAbort?: boolean
}

function formatApiFormat(apiFormat: ApiFormat | undefined): string | undefined {
    if (apiFormat === undefined) return undefined
    return ApiFormat[apiFormat]?.toLowerCase()
}

/**
 * Explain why a run stopped after repeated failed responses.
 *
 * The main task decides what to do with a failed subagent, so it gets every
 * diagnosis in order rather than a generic protocol error, plus whatever the run
 * had already reasoned out so that work is not silently discarded.
 */
function buildConsecutiveFailureError(
    failures: readonly TurnFailure[],
    usesNativeToolCalls: boolean,
    partialFindings: string,
): string {
    const lines = [
        `Subagent stopped after ${failures.length} consecutive responses without a usable tool call:`,
        ...failures.map((failure, index) => `${index + 1}. ${describeTurnFailure(failure, usesNativeToolCalls)}`),
    ]
    const findings = partialFindings.trim()
    if (findings) lines.push("", "Partial findings recovered from the run (incomplete and unverified):", findings)
    return lines.join("\n")
}

/**
 * Hand runtime feedback to the model without inventing an assistant turn.
 *
 * When the response produced nothing worth storing, the transcript still ends
 * in a user message, and the feedback joins it; otherwise it opens the next user
 * turn. Either way the user/assistant alternation providers require holds.
 */
function appendUserFeedback(conversation: ClineStorageMessage[], text: string): void {
    const block = { type: "text", text } as ClineTextContentBlock
    const lastIndex = conversation.length - 1
    const lastMessage = conversation[lastIndex]
    if (lastMessage?.role === "user" && Array.isArray(lastMessage.content)) {
        conversation[lastIndex] = { ...lastMessage, content: [...lastMessage.content, block] }
        return
    }
    conversation.push({ role: "user", content: [block] })
}

/** One provider-hosted call that reached a failed terminal state this round. */
export interface HostedServerToolFailure {
    readonly tool: ServerTool
    readonly query: string
    readonly error: string
}

function hostedServerToolLabel(tool: ServerTool): string {
    return tool === ServerTool.CODE_EXECUTION ? "code execution" : "web search"
}

/**
 * Describe failed hosted calls so the model can choose what to do next.
 *
 * A provider-hosted call is not replayable, so the runner cannot silently retry
 * it. Naming the tool, the attempted query, and the provider error gives the
 * model what it needs to retry differently, switch tools, or proceed without it.
 */
export function buildHostedServerToolFailureNotice(failures: readonly HostedServerToolFailure[]): string {
    const lines = failures.map((failure) => {
        const label = hostedServerToolLabel(failure.tool)
        const query = failure.query.trim()
        const subject = query ? `${label} for "${query}"` : label
        return `- Provider-hosted ${subject} failed: ${failure.error}`
    })
    return [
        "The provider-hosted tool call(s) below ended without a result, and the response that contained them was lost:",
        ...lines,
        "",
        "These results cannot be recovered automatically. Decide how to continue: retry with a different query, use another available tool, or proceed with what you already know. Do not repeat an identical failing call more than once.",
    ].join("\n")
}

/**
 * Fold the failure notice into the trailing user message.
 *
 * Returns false when the transcript does not end in a user message. The caller
 * must treat that as a failed recovery rather than continuing, because a run
 * that resumed without the notice would retry blind. Appending a separate
 * message is not an option: it would break the user/assistant alternation
 * providers require.
 */
export function appendHostedServerToolFailureNotice(
    conversation: ClineStorageMessage[],
    failures: readonly HostedServerToolFailure[],
): boolean {
    if (failures.length === 0) return false

    const lastIndex = conversation.length - 1
    const lastMessage = conversation[lastIndex]
    if (!lastMessage || lastMessage.role !== "user" || !Array.isArray(lastMessage.content)) return false

    const notice = { type: "text", text: buildHostedServerToolFailureNotice(failures) } as ClineTextContentBlock
    conversation[lastIndex] = { ...lastMessage, content: [...lastMessage.content, notice] }
    return true
}

export type SubagentRunStatus = "completed" | "failed" | "cancelled"

export interface SubagentRunResult {
    status: SubagentRunStatus
    result?: string
    error?: string
    retryable?: boolean
    stats: SubagentRunStats
}

interface SubagentRequestUsageState {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
    totalTokens: number
    totalCost?: number
}

interface SubagentUsageState {
    currentRequest: SubagentRequestUsageState
    lastRequest?: SubagentRequestUsageState
}

interface SubagentToolCall {
    function_id: string
    dline_tid: string
    provider_metadata?: { item_id?: string }
    signature?: string
    name: string
    input: unknown
    isNativeToolCall: boolean
}

interface SubagentContextState {
    conversationHistoryDeletedRange?: [number, number]
    roundContexts: SubagentRoundContextProjection
}

function createEmptyRequestUsageState(): SubagentRequestUsageState {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
    }
}

function serializeToolResult(result: unknown): string {
    if (typeof result === "string") {
        return result
    }

    if (Array.isArray(result)) {
        return result
            .map((item) => {
                if (!item || typeof item !== "object") {
                    return String(item)
                }

                const maybeText = (item as { text?: string }).text
                if (typeof maybeText === "string") {
                    return maybeText
                }

                return JSON.stringify(item)
            })
            .join("\n")
    }

    return JSON.stringify(result, null, 2)
}

function toToolUseParams(input: unknown): Partial<Record<string, string>> {
    if (!input || typeof input !== "object") {
        return {}
    }

    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
        params[key] = typeof value === "string" ? value : JSON.stringify(value)
    }

    return params
}

function formatToolArgPreview(value: string, maxLength = 48): string {
    const normalized = value.replace(/\s+/g, " ").trim()
    if (normalized.length <= maxLength) {
        return normalized
    }
    return `${normalized.slice(0, maxLength - 3)}...`
}

function formatToolCallPreview(toolName: string, params: Partial<Record<string, string>>): string {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined)
    const visibleEntries = entries.slice(0, 3)
    const omittedCount = Math.max(0, entries.length - visibleEntries.length)

    const args = visibleEntries
        .map(([key, value]) => `${key}=${formatToolArgPreview(value ?? "")}`)
        .concat(omittedCount > 0 ? [`...+${omittedCount}`] : [])
        .join(", ")

    return `${toolName}(${args})`
}

/**
 * Decide whether a Provider chunk already produced output that a retry cannot replay.
 *
 * Providers emit scaffolding before any answer: Anthropic adaptive thinking opens a
 * thinking block and streams `signature_delta` with empty reasoning text, and both
 * Anthropic and Codex emit standalone separators for subsequent text blocks. None of
 * that commits a Provider turn. Reasoning remains retryable, but its accumulator must
 * be reset whenever the attempt is discarded so failed content is never replayed.
 *
 * Treating every non-usage chunk as observable disabled the whole backoff sequence for
 * adaptive-thinking models, because the scaffolding always precedes the failure.
 */
function isAttemptCommitChunk(
    chunk: ApiProviderStreamChunk,
): chunk is Extract<ApiProviderStreamChunk, { type: "usage" | "tool_calls" }> {
    return chunk.type === "usage" || chunk.type === "tool_calls"
}

function producesUnreplayableOutput(chunk: ApiProviderStreamChunk): boolean {
    switch (chunk.type) {
        // Attempt-local accounting and native tool deltas are committed only after EOF.
        case "usage":
        case "tool_calls":
            return false
        // Forwarded to progress only and never written back into the conversation.
        case "reasoning":
            return false
        // Whitespace-only text is a block separator, not an answer.
        case "text":
            return (chunk.text ?? "").trim().length > 0
        // A hosted tool lifecycle is observable from its first phase: the started event is
        // already forwarded to progress and counted in the tool-call stats, so replaying the
        // attempt would duplicate both the rendered row and the count.
        case "server_tool":
            return true
    }
}

function waitForSubagentRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new Error("Subagent retry wait was aborted."))
    }

    return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined
        const onAbort = () => {
            if (timer) clearTimeout(timer)
            signal?.removeEventListener("abort", onAbort)
            reject(signal?.reason ?? new Error("Subagent retry wait was aborted."))
        }

        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, delayMs)
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}

function normalizeToolCallArguments(argumentsPayload: unknown): string {
    if (typeof argumentsPayload === "string") {
        return argumentsPayload
    }

    try {
        return JSON.stringify(argumentsPayload ?? {})
    } catch {
        return "{}"
    }
}

function toAssistantToolUseBlock(call: SubagentToolCall): ClineAssistantToolUseBlock {
    return {
        type: "tool_use",
        function_id: call.function_id,
        dline_tid: call.dline_tid,
        provider_metadata: call.provider_metadata,
        name: call.name,
        input: call.input,
        signature: call.signature,
    }
}

function parseNonNativeToolCalls(assistantText: string, identityFactory: IdentityFactory): SubagentToolCall[] {
    let ephemeralTs = Date.now()
    const identities = new Map<string, { function_id: string; dline_tid: string }>()
    const registry = {
        getOrCreateTsForBlock: (_key: string) => ++ephemeralTs,
        getOrCreateToolIdentityForBlock: (key: string) => {
            const existing = identities.get(key)
            if (existing) return existing
            const identity = {
                function_id: identityFactory.nextFunctionId(),
                dline_tid: identityFactory.nextTraceId(),
            }
            identities.set(key, identity)
            return identity
        },
    }
    const parsedBlocks = parseAssistantMessage(assistantText, registry)

    return parsedBlocks
        .filter((block): block is ToolUse => block.type === "tool_use")
        .filter((block) => !block.partial)
        .map((block) => ({
            function_id: block.function_id,
            dline_tid: block.dline_tid,
            name: block.name,
            input: block.params,
            signature: block.signature,
            isNativeToolCall: false,
        }))
}

function pushSubagentToolResultBlock(
    toolResultBlocks: ClineUserContent[],
    call: SubagentToolCall,
    label: string,
    content: string,
): void {
    if (call.isNativeToolCall) {
        toolResultBlocks.push({
            type: "tool_result",
            function_id: call.function_id,
            dline_tid: call.dline_tid,
            content,
        })
        return
    }

    toolResultBlocks.push({
        type: "text",
        text: `${label} Result:\n${content}`,
    })
}

/**
 * How long a caller waits for an abandoned tool before reclaiming its slot.
 *
 * Long enough for a normal host request or terminal write to unwind, short
 * enough that one wedged tool cannot stall an entire batch.
 */
const ABANDONED_TOOL_SETTLE_TIMEOUT_MS = 30_000

/** Raised when a tool wait is abandoned because the run was interrupted. */
class SubagentToolInterruptedError extends Error {
    constructor() {
        super("Subagent tool execution was interrupted.")
        this.name = "SubagentToolInterruptedError"
    }
}

export class SubagentRunner {
    private readonly agent: SubagentBuilder
    private readonly apiHandler: ApiHandler
    private readonly allowedTools: DlineDefaultTool[]
    private readonly identityFactory = createIdentityFactory()
    private readonly providerRequestSource: Extract<ProviderTelemetryRole, "subagent" | "reviewer">
    private activeApiAbort: (() => void) | undefined
    private activeRetryAbortController: AbortController | undefined
    private abortRequested = false
    private finishRequested: SubagentFinishReason | undefined
    private completionOnly = false
    private running = false
    /** The run that has not unwound yet; a retry waits for it instead of racing it. */
    private activeRun: Promise<SubagentRunResult> | undefined
    /** This run's share of the main task's context budget; absent when the call carried none. */
    private activeBudget: TaskConfig["contextBudget"]
    private activeCommandExecutions = 0
    private abortingCommands = false
    private apiLogRequestIndex = 0
    private interruptionController: AbortController | undefined
    private activeToolState: DefaultToolHandlerState | undefined
    /** Capture the parent's operation scope once; a later rearm cannot revive this run. */
    private inheritedOperationSignal: AbortSignal | undefined
    /**
     * Tool executions the run stopped waiting for but that are still running.
     *
     * An interrupted run reports `cancelled` immediately while the abandoned
     * tool keeps holding a terminal, a file handle or a host request. Treating
     * the run as finished at that moment would free a concurrency slot the
     * machine has not actually reclaimed, so the abandoned work is tracked and
     * the owner of the slot can wait for it.
     */
    private readonly abandonedToolExecutions = new Set<Promise<unknown>>()
    /**
     * Abandoned work whose capacity cost has already been handed to a budget.
     *
     * A runner outlives its attempts, so a tool wedged during attempt 1 is
     * still in `abandonedToolExecutions` when a retry finishes. Without this
     * record the retry would charge the same wedged tool a second time and
     * shrink the allowance below the work that is genuinely outstanding.
     */
    private readonly claimedAbandonedWork = new Set<Promise<unknown>>()

    constructor(
        private baseConfig: TaskConfig,
        subagentName = "subagent",
        agentConfig?: AgentBaseConfig,
        private readonly options: SubagentRunnerOptions = {},
    ) {
        this.providerRequestSource = providerTelemetryRoleForSubagent(agentConfig?.name ?? subagentName)
        this.agent = new SubagentBuilder(baseConfig, subagentName, agentConfig)
        this.apiHandler = this.agent.getApiHandler()
        this.allowedTools = this.agent.getAllowedTools()
    }

    async abort(): Promise<void> {
        this.abortRequested = true
        this.activeToolState?.cancelOperations("subagent_run_cancelled")
        await this.interruptActiveWork("abort")
    }

    async requestFinish(reason: SubagentFinishReason): Promise<boolean> {
        if (!this.canAcceptFinishRequest()) return false
        this.finishRequested = reason
        await this.interruptActiveWork("finish")
        return true
    }

    /**
     * Ask the run to converge without disturbing the turn already in flight.
     *
     * Context pressure is observed from the run's own usage accounting, at a
     * point where the current response has already been paid for. Interrupting
     * it would discard work that is complete, so the order is recorded and takes
     * effect when the next turn is composed.
     */
    private requestFinishAfterCurrentTurn(reason: SubagentFinishReason): boolean {
        if (!this.canAcceptFinishRequest()) return false
        this.finishRequested = reason
        return true
    }

    private canAcceptFinishRequest(): boolean {
        return Boolean(this.running) && !this.finishRequested && !this.completionOnly && !this.shouldAbort()
    }

    /**
     * Wait for a tool call, but stop waiting once the run is interrupted.
     *
     * Cooperative handlers receive the run's operation signal. A handler that
     * ignores it can still be wedged on a parser lock or host request, so racing
     * the interruption signal releases the runner's wait while retaining the
     * abandoned work for resource and capacity accounting.
     */
    private async executeToolWithInterruption<T>(execute: () => Promise<T>): Promise<T> {
        const signal = this.interruptionController?.signal
        const toolExecution = execute()
        if (!signal) return toolExecution
        // An abort that already happened is still an abandonment: the tool has
        // started and holds resources. Bailing out before the tracking below
        // would free the slot while that work continues, so the same path is
        // taken whether the signal fires before or during the wait.
        if (signal.aborted) {
            this.trackAbandonedTool(toolExecution)
            throw new SubagentToolInterruptedError()
        }
        let onAbort: (() => void) | undefined
        try {
            return await Promise.race([
                toolExecution,
                new Promise<never>((_, reject) => {
                    onAbort = () => reject(new SubagentToolInterruptedError())
                    signal.addEventListener("abort", onAbort, { once: true })
                }),
            ])
        } finally {
            if (onAbort) signal.removeEventListener("abort", onAbort)
            if (signal.aborted) this.trackAbandonedTool(toolExecution)
        }
    }

    /**
     * Keep an abandoned tool observable after the run has moved on.
     *
     * The rejection is swallowed here because nothing is waiting on the result
     * any more; the purpose of holding the promise is only to know when the
     * work stops.
     *
     * @param toolExecution The still-running tool call.
     */
    private trackAbandonedTool(toolExecution: Promise<unknown>): void {
        const settled = Promise.resolve(toolExecution).catch(() => undefined)
        this.abandonedToolExecutions.add(settled)
        void settled.finally(() => {
            this.abandonedToolExecutions.delete(settled)
            this.claimedAbandonedWork.delete(settled)
        })
    }

    /**
     * Wait until every tool this run abandoned has stopped.
     *
     * Resolves immediately when nothing was abandoned, which is the normal
     * path. A caller that releases a concurrency permit on the run's behalf
     * awaits this first so the reported capacity matches the real one.
     *
     * The wait is bounded: a tool that never settles is exactly the failure
     * this mechanism exists for, and blocking forever would stop the remaining
     * batch items from ever running. On timeout the caller proceeds and the
     * capacity estimate is knowingly optimistic rather than deadlocked.
     *
     * @param timeoutMs Maximum time to wait before giving up.
     * @returns Whether all abandoned work stopped within the deadline.
     */
    /**
     * Take ownership of the abandoned work nobody is accounting for yet.
     *
     * A caller that gave up waiting uses this to keep accounting honest: the
     * permit can go back while the allowance stays reduced until the returned
     * promise settles. The claim is one-shot, because the same wedged tool
     * survives into later attempts on this runner and must be charged once,
     * not once per attempt.
     *
     * @returns A promise settling when every newly claimed tool stops, or
     *   undefined when nothing is outstanding beyond what was already claimed.
     */
    claimOutstandingAbandonedWork(): Promise<unknown> | undefined {
        const unclaimed = [...this.abandonedToolExecutions].filter((work) => !this.claimedAbandonedWork.has(work))
        if (unclaimed.length === 0) return undefined
        for (const work of unclaimed) {
            this.claimedAbandonedWork.add(work)
        }
        return Promise.all(unclaimed)
    }

    async whenAbandonedWorkSettled(timeoutMs = ABANDONED_TOOL_SETTLE_TIMEOUT_MS): Promise<boolean> {
        const deadline = Date.now() + timeoutMs
        while (this.abandonedToolExecutions.size > 0) {
            const remaining = deadline - Date.now()
            if (remaining <= 0) return false
            let timer: NodeJS.Timeout | undefined
            const expired = new Promise<"expired">((resolve) => {
                timer = setTimeout(() => resolve("expired"), remaining)
            })
            try {
                const outcome = await Promise.race([Promise.all([...this.abandonedToolExecutions]), expired])
                if (outcome === "expired") return false
            } finally {
                if (timer) clearTimeout(timer)
            }
        }
        return true
    }

    private async interruptActiveWork(action: "abort" | "finish"): Promise<void> {
        this.activeRetryAbortController?.abort()
        // Only an abort abandons an in-flight tool. `finish` is a cooperative
        // wind-down that still wants the current tool's result before steering the
        // next turn to attempt_completion.
        if (action === "abort") this.interruptionController?.abort()
        try {
            this.activeApiAbort?.()
        } catch (error) {
            Logger.error(`[SubagentRunner] failed to ${action} active API stream`, error)
        }

        if (this.activeCommandExecutions > 0 && !this.abortingCommands && this.baseConfig.callbacks.cancelRunningCommandTool) {
            this.abortingCommands = true
            try {
                await this.baseConfig.callbacks.cancelRunningCommandTool()
            } catch (error) {
                Logger.error(`[SubagentRunner] failed to ${action} running command execution`, error)
            } finally {
                this.abortingCommands = false
            }
        }
    }

    private shouldAbort(): boolean {
        return this.abortRequested || this.inheritedOperationSignal?.aborted === true
    }

    private async getWorkspaceMetadataJson(): Promise<string | null> {
        try {
            return (
                (await this.baseConfig.workspaceManager?.buildWorkspacesJson()) ??
                JSON.stringify(
                    {
                        workspaces: {
                            [this.baseConfig.cwd]: {
                                hint: path.basename(this.baseConfig.cwd) || this.baseConfig.cwd,
                            },
                        },
                    },
                    null,
                    2,
                )
            )
        } catch (error) {
            Logger.warn("[SubagentRunner] Failed to build workspace metadata block", error)
            return null
        }
    }

    /**
     * Build the static environment block carried by the initial user message.
     *
     * Context usage is deliberately excluded: it changes every turn and is
     * attached to the outgoing request instead, so the stored transcript keeps a
     * single stable copy of the workspace facts.
     */
    private buildEnvironmentBlock(workspacesJson: string | null): string | null {
        if (!workspacesJson) return null
        return `<environment_details>\n# Workspace Configuration\n${workspacesJson}\n</environment_details>`
    }

    /**
     * Run the subagent, serializing against a run that has not unwound yet.
     *
     * A retry can be requested while the previous run is still settling: an
     * aborted stream, a hosted tool lifecycle, and a running command all unwind
     * asynchronously. Both runs share this instance, so starting the second one
     * eagerly let it reset `abortRequested` and replace the abort controllers the
     * first one was still using. The two runs then cancelled each other's
     * requests and overwrote each other's results. Waiting for the previous run
     * keeps one live run per runner without silently refusing the retry.
     */
    async run(prompt: string, onProgress: (update: SubagentProgressUpdate) => void): Promise<SubagentRunResult> {
        while (this.activeRun) {
            await this.activeRun.catch(() => undefined)
        }
        // One consumer of the main task's budget per run: it draws a share while
        // working and counts its result the moment it returns.
        const budget = this.baseConfig.contextBudget?.child()
        this.activeBudget = budget
        const execution = this.execute(prompt, onProgress)
        this.activeRun = execution
        let settled: SubagentRunResult | undefined
        try {
            settled = await execution
            return settled
        } finally {
            budget?.end(settled?.result ? Buffer.byteLength(settled.result, "utf8") : 0)
            if (this.activeBudget === budget) this.activeBudget = undefined
            if (this.activeRun === execution) this.activeRun = undefined
        }
    }

    private async execute(prompt: string, onProgress: (update: SubagentProgressUpdate) => void): Promise<SubagentRunResult> {
        this.abortRequested = false
        this.finishRequested = undefined
        this.completionOnly = false
        this.running = true
        this.activeRetryAbortController = new AbortController()
        this.interruptionController = new AbortController()
        const state = new DefaultToolHandlerState()
        this.activeToolState = state
        const parentSignal = this.options.inheritTaskAbort === false ? undefined : this.baseConfig.taskState.operationSignal
        this.inheritedOperationSignal = parentSignal
        const onParentAbort = () => {
            if (this.activeToolState !== state) return
            void this.abort().catch((error) => Logger.error("[SubagentRunner] Failed to cancel inherited operation scope", error))
        }
        const turnFailures = new ConsecutiveTurnFailures(MAX_CONSECUTIVE_TURN_FAILURES)
        // Latest narrative text produced by the run, used to salvage findings if
        // the model never converts them into an attempt_completion result.
        let latestAssistantNarrative = ""
        const contextState: SubagentContextState = {
            roundContexts: new SubagentRoundContextProjection(),
        }
        const contextManager = new ContextManager()
        const usageState: SubagentUsageState = {
            currentRequest: createEmptyRequestUsageState(),
        }
        const stats: SubagentRunStats = {
            toolCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            totalCost: 0,
            currency: "",
            contextTokens: 0,
            contextWindow: 0,
            contextUsagePercentage: 0,
        }
        let activeHostedServerToolLifecycle: ServerToolLifecycle | undefined
        // Hosted calls a response deferred behind its client tools; the next request of this run may resume them.
        let deferredHostedCalls: DeferredServerToolCall[] = []

        try {
            const mode = "act" as const
            const api = this.apiHandler
            const imageGenerationService = this.baseConfig.services.imageGenerationService.withProfileResolver(
                createImageProfileResolverForProfile({
                    profileId: this.agent.getProfileId(),
                    profileName: this.agent.getProfileName(),
                }),
            )
            const outputBudget = resolveSubagentOutputBudget(this.baseConfig, this.agent.getConfiguredMaxOutputTokens())
            const promptWithBudget = buildSubagentOutputBudgetPrompt(prompt)
            // The subagent's own tool results fill its own context, so they share
            // what is left of its window the way the main task's results share the task's.
            // The same W its compaction trigger uses: the user's Maximum context bounds both.
            const toolBudget = new ContextBudgetLedger({
                contextWindow: () =>
                    resolveConfiguredContextWindow(
                        stats.contextWindow > 0 ? stats.contextWindow : getContextWindowInfo(api).contextWindow,
                        {
                            maxContextTokens:
                                this.baseConfig.services.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
                        },
                    ),
                occupiedTokens: () => stats.contextTokens,
                tokenPerByte: () => DEFAULT_TOKEN_PER_BYTE,
            })
            this.activeApiAbort = api.abort?.bind(api)
            parentSignal?.addEventListener("abort", onParentAbort, { once: true })
            if (parentSignal?.aborted) onParentAbort()

            // Use handler's provider ID to avoid cross-task interference from global StateManager
            const providerId = api.getProviderId?.() ?? DEFAULT_API_PROVIDER
            const providerInfo = {
                providerId,
                model: api.getModel(),
                mode,
                customPrompt: this.baseConfig.services.stateManager.getGlobalSettingsKey("customPrompt"),
            }
            const webToolsEnabled =
                this.baseConfig.webToolsEnabled ??
                this.baseConfig.services.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true
            stats.contextWindow = providerInfo.model.info.capabilities?.contextWindow || 0
            stats.currency = providerInfo.model.info.pricing?.currency || "USD"
            const apiFormat = providerInfo.model.info.apiFormats?.[0]
            const nativeToolCallsRequested =
                apiFormat === ApiFormat.OPENAI_RESPONSES ||
                apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE ||
                !!this.baseConfig.services.stateManager.getGlobalStateKey("nativeToolCallEnabled")
            const useNativeToolCalls = isNativeToolCallingConfig(providerInfo, nativeToolCallsRequested)
            const webSearchRoutingPlan = this.resolveAllowedWebRoutingPlan(api, webToolsEnabled, useNativeToolCalls)
            const turnFailureFeedback = (failure: TurnFailure): string => {
                const feedback = buildTurnFailureFeedback(failure, {
                    usesNativeToolCalls: useNativeToolCalls,
                    availableTools: this.completionOnly ? [DlineDefaultTool.ATTEMPT] : this.allowedTools,
                    finishing: this.completionOnly,
                    consecutiveFailures: turnFailures.count,
                    maxConsecutiveFailures: turnFailures.limit,
                })
                // A subagent that answered in prose believes it is done; restate how a run ends.
                const completionMisunderstood = failure.kind === "text_only" || failure.kind === "missing_completion_result"
                return completionMisunderstood ? `${feedback}\n\n${SUBAGENT_COMPLETION_CONTRACT}` : feedback
            }
            const failAfterConsecutiveTurnFailures = (): SubagentRunResult => {
                const partialFindings = truncateTextToSubagentOutputBudget(
                    latestAssistantNarrative,
                    resolveFinalResultTokens(outputBudget.outputTokens, this.activeBudget),
                )
                const error = buildConsecutiveFailureError(turnFailures.list(), useNativeToolCalls, partialFindings)
                onProgress({ status: "failed", error, stats: { ...stats } })
                return { status: "failed", error, stats }
            }
            const reasoning = this.agent.getReasoningConfig()
            onProgress({
                status: "running",
                runtime: {
                    profileName: this.agent.getProfileName(),
                    providerId,
                    modelId: providerInfo.model.id,
                    apiFormat: formatApiFormat(apiFormat),
                    thinkingEnabled: reasoning?.enableThinking,
                    reasoningEffort: reasoning?.effort,
                    thinkingBudgetTokens: reasoning?.thinkingBudget,
                },
                stats: { ...stats },
            })

            const host = HostRegistryInfo.get()
            const remoteSkillEntries = this.baseConfig.services.stateManager.getRemoteConfigSettings().remoteGlobalSkills || []
            const availableSkills = await discoverAvailableSkills(this.baseConfig.cwd, {
                remoteSkillEntries,
                globalSkillsToggles: this.baseConfig.capabilityToggles.globalSkillsToggles,
                localSkillsToggles: this.baseConfig.capabilityToggles.localSkillsToggles,
                remoteSkillsToggles: this.baseConfig.capabilityToggles.remoteSkillsToggles,
            })
            const configuredSkillNames = this.agent.getConfiguredSkills()
            const skills =
                configuredSkillNames !== undefined
                    ? configuredSkillNames
                          .map((skillName) => {
                              const skill = availableSkills.find((candidate) => candidate.name === skillName)
                              if (!skill) {
                                  Logger.warn(`[SubagentRunner] Configured skill '${skillName}' not found for subagent run.`)
                              }
                              return skill
                          })
                          .filter((skill): skill is (typeof availableSkills)[number] => Boolean(skill))
                    : availableSkills

            const allowedTools = new Set(this.allowedTools)
            const context: SystemPromptContext = {
                providerInfo,
                promptProfile: resolvePromptProfile({
                    modelId: providerInfo.model.id,
                    contextWindow: providerInfo.model.info.capabilities?.contextWindow,
                }),
                cwd: this.baseConfig.cwd,
                ide: host?.platform || "Unknown",
                skills,
                // A subagent keeps no TODO list, so its tools must not offer task_progress.
                focusChainSettings: { ...this.baseConfig.focusChainSettings, enabled: false },
                browserSettings: this.baseConfig.browserSettings,
                yoloModeToggled: false,
                enableNativeToolCalls: useNativeToolCalls,
                enableParallelToolCalling: false,
                isSubagentRun: true,
                disableTools: Object.values(DlineDefaultTool).filter((tool) => !allowedTools.has(tool)),
                clineWebToolsEnabled: webToolsEnabled,
                webSearchRoutingPlan,
                imageGenerationAvailable: imageGenerationService.hasAvailableProfile(),
            }

            const generated = await getSystemPrompt(context)
            // A finish request keeps this prompt and tool list unchanged and only
            // appends a reminder: swapping either would invalidate the provider's
            // prompt cache exactly when the run is out of time. The runner itself
            // refuses every tool except attempt_completion once finishing.
            const systemPrompt = this.agent.buildSystemPrompt(generated.systemPrompt)
            const nativeTools = generated.tools?.filter((tool) => {
                if ("function" in tool) {
                    return allowedTools.has(tool.function.name as DlineDefaultTool)
                }
                if ("name" in tool && typeof tool.name === "string") {
                    return allowedTools.has(tool.name as DlineDefaultTool)
                }
                return false
            })
            const workspacesJson = await this.getWorkspaceMetadataJson()
            const workspaceMetadataEnvironmentBlock = this.buildEnvironmentBlock(workspacesJson)

            if (useNativeToolCalls && (!nativeTools || nativeTools.length === 0)) {
                const error = "Subagent tool requires native tool calling support."
                onProgress({ status: "failed", error, stats })
                return { status: "failed", error, stats }
            }

            if (this.shouldAbort()) {
                await this.abort()
                const error = "Subagent run cancelled."
                onProgress({ status: "cancelled", error, stats: { ...stats } })
                return { status: "cancelled", error, retryable: true, stats }
            }

            const conversation: ClineStorageMessage[] = [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: promptWithBudget,
                        } as ClineTextContentBlock,
                        // Server-side task loop checks require workspace metadata to be present in the
                        // initial user message of subagent runs.
                        ...(workspaceMetadataEnvironmentBlock
                            ? [
                                  {
                                      type: "text",
                                      text: workspaceMetadataEnvironmentBlock,
                                  } as ClineTextContentBlock,
                              ]
                            : []),
                    ],
                },
            ]

            let hostedServerToolRecoveries = 0

            while (true) {
                if (this.shouldAbort()) {
                    await this.abort()
                    const error = "Subagent run cancelled."
                    onProgress({ status: "cancelled", error, stats: { ...stats } })
                    return { status: "cancelled", error, retryable: true, stats }
                }
                if (this.finishRequested && !this.completionOnly) {
                    this.completionOnly = true
                    this.activeRetryAbortController = new AbortController()
                    conversation.push({
                        role: "user",
                        content: [{ type: "text", text: buildFinishReminder(this.finishRequested, useNativeToolCalls) }],
                    })
                }

                if (
                    usageState.lastRequest &&
                    this.shouldCompactBeforeNextRequest(usageState.lastRequest.totalTokens, api, providerInfo.model.id)
                ) {
                    const compactResult = this.compactConversationForContextWindow(
                        contextManager,
                        conversation,
                        contextState.conversationHistoryDeletedRange,
                    )
                    contextState.conversationHistoryDeletedRange = compactResult.conversationHistoryDeletedRange
                    if (compactResult.didCompact) {
                        Logger.warn("[SubagentRunner] Proactively compacted context before next subagent request.")
                    }
                    // Prevent repeated compaction attempts off the same token sample.
                    usageState.lastRequest = undefined
                }

                // Ephemeral ts factory for subagent internal parsing.
                // Uses Date.now() monotonic counter — subagent UI is not
                // rendered via main task presentation, so these ts values
                // only need to satisfy the ToolUse type contract.
                let ephemeralTs = Date.now()
                const streamHandler = new StreamResponseHandler(() => ++ephemeralTs)
                const { reasonsHandler, toolUseHandler } = streamHandler.getHandlers()
                usageState.currentRequest = createEmptyRequestUsageState()
                const requestUsage = usageState.currentRequest
                // Every exit from the stream has to settle, including a recovered
                // hosted-tool failure. Skipping it would drop this request's cost and
                // leave the next turn's compaction check reading a stale token sample.
                const settleRequestUsage = (): void => {
                    const calculatedRequestCost =
                        requestUsage.totalCost ??
                        calculateApiCostAnthropic(
                            providerInfo.model.info,
                            requestUsage.inputTokens,
                            requestUsage.outputTokens,
                            requestUsage.cacheWriteTokens,
                            requestUsage.cacheReadTokens,
                        )
                    requestUsage.totalTokens =
                        requestUsage.inputTokens +
                        requestUsage.outputTokens +
                        requestUsage.cacheWriteTokens +
                        requestUsage.cacheReadTokens
                    stats.totalCost += calculatedRequestCost || 0
                    usageState.lastRequest = { ...requestUsage }
                }
                let recoveredFromHostedServerToolFailure = false

                let assistantText = ""
                let assistantTextSignature: string | undefined
                let proseStream = new SubagentProseStream()
                let requestId: string | undefined
                // Completed provider-hosted calls (web search/fetch results) the endpoint needs back
                // verbatim on later requests; without them the subagent loses what it just looked up.
                const hostedToolBlocks: ClineAssistantContent[] = []
                const countedHostedServerToolIds = new Set<string>()
                // Both a provider-sent `failed` phase and a force-close from
                // `finalizeOpen` emit through this same callback, so collecting here
                // catches every failure without inspecting lifecycle internals.
                const failedHostedServerTools: HostedServerToolFailure[] = []
                const requestWebSearchRoutingPlan = webSearchRoutingPlan
                activeHostedServerToolLifecycle = new ServerToolLifecycle(requestWebSearchRoutingPlan, true, (update) => {
                    if (!countedHostedServerToolIds.has(update.dlineTid)) {
                        countedHostedServerToolIds.add(update.dlineTid)
                        stats.toolCalls += 1
                    }
                    if (update.status === "failed") {
                        failedHostedServerTools.push({
                            tool: update.tool,
                            query: update.query,
                            error: update.error ?? "The provider reported no error detail.",
                        })
                    }
                    // Report the tool that actually ran: a hardcoded name would attribute
                    // sandbox work to web search in progress output.
                    const toolName =
                        update.tool === ServerTool.CODE_EXECUTION
                            ? "code_execution"
                            : update.tool === ServerTool.WEB_FETCH
                              ? "web_fetch"
                              : "web_search"
                    onProgress({
                        stats: { ...stats },
                        latestToolCall: toolName,
                        event:
                            update.status === "completed" || update.status === "failed"
                                ? {
                                      kind: "tool_result",
                                      phase: "final",
                                      toolCallId: update.dlineTid,
                                      toolName,
                                      toolStatus: update.status,
                                      error: update.error,
                                  }
                                : {
                                      kind: "tool_call",
                                      phase: "delta",
                                      toolCallId: update.dlineTid,
                                      toolName,
                                      toolStatus: "started",
                                  },
                    })
                })

                const deferral = partitionDeferredHostedCalls(deferredHostedCalls, conversation, {
                    protocol: api.getHostedToolReplayProtocol?.(),
                    replayHostedTools: declaredAnthropicHostedToolNames(requestWebSearchRoutingPlan?.serverTools),
                })
                deferredHostedCalls = []
                activeHostedServerToolLifecycle.adopt(deferral.abandoned)
                await activeHostedServerToolLifecycle.failDeferred(HOSTED_SERVER_TOOL_DEFERRED_ABANDONED_REASON)
                activeHostedServerToolLifecycle.adopt(deferral.carried)
                for (const call of deferral.carried) countedHostedServerToolIds.add(call.dlineTid)
                const carriedTraceIds = new Map(deferral.carried.map((call) => [call.functionId, call.dlineTid]))

                const roundUsageAccumulator = new ApiUsageAccumulator()
                let roundStopReason: ApiStopReason | undefined
                // This request carries every tool result produced so far.
                toolBudget.clearStaged()
                const roundContext = contextState.roundContexts.freeze(
                    conversation,
                    [
                        buildContextUsageSection({
                            contextTokens: stats.contextTokens,
                            contextWindow: stats.contextWindow,
                        }),
                        buildContextBudgetSection(this.activeBudget, outputBudget.outputTokens),
                    ]
                        .filter((section): section is string => Boolean(section))
                        .join("\n\n") || undefined,
                )
                const providerStream = this.createMessageWithInitialChunkRetry(
                    api,
                    systemPrompt,
                    conversation,
                    nativeTools,
                    providerInfo.providerId,
                    providerInfo.model.id,
                    contextManager,
                    contextState,
                    roundContext,
                    requestWebSearchRoutingPlan,
                    () => {
                        reasonsHandler.reset()
                        assistantText = ""
                        assistantTextSignature = undefined
                        proseStream = new SubagentProseStream()
                        requestId = undefined
                        hostedToolBlocks.length = 0
                    },
                    onProgress,
                )
                const stream = normalizeApiStream(
                    providerStream,
                    createStreamNormalizer(this.identityFactory, {
                        carriedServerToolTraceId: (functionId) => carriedTraceIds.get(functionId),
                    }),
                )

                try {
                    for await (const chunk of stream) {
                        switch (chunk.type) {
                            case "usage":
                                requestId = requestId ?? chunk.provider_metadata?.response_id
                                // Providers may resend cumulative usage snapshots; only the
                                // accumulator's delta is new and may be added to running totals.
                                const { delta: usageDelta } = roundUsageAccumulator.apply(chunk)
                                if (chunk.stopReason) roundStopReason = chunk.stopReason
                                stats.inputTokens += usageDelta.inputTokens
                                stats.outputTokens += usageDelta.outputTokens
                                stats.cacheWriteTokens += usageDelta.cacheWriteTokens
                                stats.cacheReadTokens += usageDelta.cacheReadTokens
                                requestUsage.inputTokens += usageDelta.inputTokens
                                requestUsage.outputTokens += usageDelta.outputTokens
                                requestUsage.cacheWriteTokens += usageDelta.cacheWriteTokens
                                requestUsage.cacheReadTokens += usageDelta.cacheReadTokens
                                requestUsage.totalTokens =
                                    requestUsage.inputTokens +
                                    requestUsage.outputTokens +
                                    requestUsage.cacheWriteTokens +
                                    requestUsage.cacheReadTokens
                                requestUsage.totalCost = chunk.totalCost ?? requestUsage.totalCost
                                stats.contextTokens = requestUsage.totalTokens
                                stats.contextUsagePercentage =
                                    stats.contextWindow > 0 ? (stats.contextTokens / stats.contextWindow) * 100 : 0
                                onProgress({ stats: { ...stats } })

                                // Past this point the remaining window has to carry the
                                // final result, so the run converges from the next turn on.
                                if (exceedsContextConvergenceThreshold(stats)) {
                                    if (this.requestFinishAfterCurrentTurn("context_pressure")) {
                                        Logger.warn(
                                            "[SubagentRunner] Context usage crossed the convergence threshold; steering the next turn to attempt_completion.",
                                        )
                                    }
                                }
                                break
                            case "text":
                                requestId = requestId ?? chunk.provider_metadata?.response_id
                                assistantText += chunk.text || ""
                                assistantTextSignature = chunk.signature || assistantTextSignature
                                const proseDelta = proseStream.next(assistantText)
                                if (proseDelta) {
                                    onProgress({ event: { kind: "assistant_message", phase: "delta", text: proseDelta } })
                                }
                                break
                            case "tool_calls":
                                requestId = requestId ?? chunk.provider_metadata?.response_id
                                toolUseHandler.processToolUseDelta(
                                    {
                                        type: "tool_use",
                                        name: chunk.tool_call.function?.name,
                                        input: normalizeToolCallArguments(chunk.tool_call.function?.arguments),
                                        signature: chunk.signature,
                                    },
                                    {
                                        function_id: chunk.function_id,
                                        dline_tid: chunk.dline_tid,
                                        provider_metadata: chunk.provider_metadata,
                                    },
                                )
                                break
                            case "server_tool": {
                                requestId = requestId ?? chunk.provider_metadata?.response_id
                                if (chunk.replay) hostedToolBlocks.push(chunk.replay)
                                await activeHostedServerToolLifecycle.consume(chunk)
                                break
                            }
                            case "reasoning": {
                                requestId = requestId ?? chunk.provider_metadata?.response_id
                                const details = chunk.details
                                    ? Array.isArray(chunk.details)
                                        ? chunk.details
                                        : [chunk.details]
                                    : []
                                reasonsHandler.processReasoningDelta({
                                    provider_metadata: chunk.provider_metadata,
                                    reasoning: chunk.reasoning,
                                    signature: chunk.signature,
                                    details,
                                    redacted_data: chunk.redacted_data,
                                    redacted_phase: chunk.redacted_phase,
                                })
                                if (chunk.reasoning) {
                                    onProgress({ event: { kind: "thinking", phase: "delta", text: chunk.reasoning } })
                                }
                                break
                            }
                        }

                        if (this.shouldAbort()) {
                            await activeHostedServerToolLifecycle.finalizeOpen(HOSTED_SERVER_TOOL_CANCELLED_REASON)
                            await this.abort()
                            const error = "Subagent run cancelled."
                            onProgress({ status: "cancelled", error, stats: { ...stats } })
                            return { status: "cancelled", error, retryable: true, stats }
                        }
                    }
                } catch (streamError) {
                    // A hosted call is unreplayable, so a stream dying after one started
                    // used to end the entire run. Hand the failure back to the model
                    // instead, but only when a hosted call actually failed: every other
                    // error is an internal fault that must keep propagating rather than
                    // be absorbed by this narrow recovery.
                    if (this.shouldAbort()) throw streamError

                    // Close first, then decide. A call that was merely open has not
                    // reported a failure yet, so testing the collected failures before
                    // this would miss the very case this recovery exists for. Closing
                    // routes it through the same callback a provider-sent failure uses.
                    await activeHostedServerToolLifecycle.finalizeOpen(HOSTED_SERVER_TOOL_STREAM_FAILED_REASON)

                    if (failedHostedServerTools.length === 0) throw streamError
                    if (hostedServerToolRecoveries >= MAX_HOSTED_SERVER_TOOL_RECOVERIES) throw streamError
                    // The assistant message is only pushed after the stream drains, so a
                    // mid-stream failure leaves a trailing user message to fold into.
                    if (!appendHostedServerToolFailureNotice(conversation, failedHostedServerTools)) throw streamError

                    hostedServerToolRecoveries += 1
                    recoveredFromHostedServerToolFailure = true
                    Logger.warn(
                        `[SubagentRunner] Provider stream failed after ${failedHostedServerTools.length} hosted tool failure(s); returning control to the subagent model.`,
                    )
                }
                contextState.roundContexts.commit(roundContext)
                // Settle before looping so the recovered turn is billed and sampled
                // exactly like a turn that drained normally.
                if (recoveredFromHostedServerToolFailure) {
                    settleRequestUsage()
                    continue
                }

                await activeHostedServerToolLifecycle.finalizeOpen(HOSTED_SERVER_TOOL_STREAM_ENDED_REASON)
                deferredHostedCalls = activeHostedServerToolLifecycle.deferredCalls()

                // A clean end needs no notice: the provider already surfaced the failed
                // call inside the response the model just produced, so the model has
                // seen it and answered with that knowledge.
                settleRequestUsage()

                // Keep the most recent narrative so a run that never converges can
                // still hand back what it had reasoned out.
                const assistantProse = SubagentProseStream.final(assistantText)
                if (assistantProse) latestAssistantNarrative = assistantProse

                const nativeFinalizedToolCalls: SubagentToolCall[] = toolUseHandler.getAllFinalizedToolUses().map((toolCall) => {
                    if (!toolCall.function_id || !toolCall.dline_tid) {
                        throw new Error(`Canonical subagent tool call is missing identity: tool=${toolCall.name}`)
                    }
                    return {
                        function_id: toolCall.function_id,
                        dline_tid: toolCall.dline_tid,
                        provider_metadata: toolCall.provider_metadata,
                        signature: toolCall.signature,
                        name: toolCall.name,
                        input: toolCall.input,
                        isNativeToolCall: true,
                    }
                })
                const parsedNonNativeToolCalls = useNativeToolCalls
                    ? []
                    : parseNonNativeToolCalls(assistantText, this.identityFactory)
                const fallbackNonNativeToolCalls = nativeFinalizedToolCalls.map((toolCall) => ({
                    ...toolCall,
                    isNativeToolCall: false,
                }))

                let finalizedToolCalls: SubagentToolCall[] = []
                let usedStructuredNonNativeFallback = false
                if (useNativeToolCalls) {
                    finalizedToolCalls = nativeFinalizedToolCalls
                } else if (parsedNonNativeToolCalls.length > 0) {
                    finalizedToolCalls = parsedNonNativeToolCalls
                } else if (fallbackNonNativeToolCalls.length > 0) {
                    // Defensive fallback: if non-native mode receives structured tool call chunks,
                    // execute them but serialize results as plain text to avoid tool_result pairing mismatches.
                    Logger.warn(
                        "[SubagentRunner] Received structured tool_calls while native tool calling is disabled; falling back to non-native result serialization.",
                    )
                    usedStructuredNonNativeFallback = true
                    finalizedToolCalls = fallbackNonNativeToolCalls
                }
                if (this.finishRequested && !this.completionOnly) {
                    const validCompletion = finalizedToolCalls.some((call) => {
                        if (call.name !== DlineDefaultTool.ATTEMPT) return false
                        return Boolean(toToolUseParams(call.input).result?.trim())
                    })
                    if (!validCompletion) {
                        this.completionOnly = true
                        this.activeRetryAbortController = new AbortController()
                        conversation.push({
                            role: "user",
                            content: [{ type: "text", text: buildFinishReminder(this.finishRequested, useNativeToolCalls) }],
                        })
                        await Promise.resolve()
                        continue
                    }
                }

                const assistantContent: ClineAssistantContent[] = [...reasonsHandler.getRedactedThinking()]
                const thinkingBlock = reasonsHandler.getCurrentReasoning()
                if (thinkingBlock) {
                    assistantContent.push({ ...thinkingBlock })
                }
                // Hosted calls ran before the visible answer, so they precede it in the stored turn.
                const hostedTurn = splitResumedHostedResults(hostedToolBlocks)
                assistantContent.unshift(...hostedTurn.resumed)
                assistantContent.push(...hostedTurn.others)
                if (assistantText.trim().length > 0) {
                    if (assistantProse) {
                        onProgress({ event: { kind: "assistant_message", phase: "final", text: assistantProse } })
                    }
                    assistantContent.push({
                        type: "text",
                        text: assistantText,
                        signature: assistantTextSignature,
                    })
                }
                if (usedStructuredNonNativeFallback && assistantText.trim().length === 0) {
                    assistantContent.push({
                        type: "text",
                        text: `Tool calls: ${finalizedToolCalls.map((call) => call.name).join(", ")}`,
                    })
                }
                if (useNativeToolCalls) {
                    assistantContent.push(...finalizedToolCalls.map(toAssistantToolUseBlock))
                }
                // Preserve every provider-issued assistant block before adding runtime feedback.
                // In particular, signed or redacted reasoning carries multi-turn continuity even
                // when the response contains no visible text or tool call.
                if (assistantContent.length > 0) {
                    conversation.push({
                        role: "assistant",
                        content: assistantContent,
                        provider_metadata: requestId && !usedStructuredNonNativeFallback ? { response_id: requestId } : undefined,
                    })
                }

                if (finalizedToolCalls.length === 0) {
                    const failure = classifyToollessTurn(
                        {
                            visibleText: assistantText,
                            reasoningPresent: assistantContent.some(
                                (block) => block.type === "thinking" || block.type === "redacted_thinking",
                            ),
                            outputTokens: requestUsage.outputTokens,
                            stopReason: roundStopReason,
                        },
                        this.allowedTools,
                    )
                    turnFailures.record(failure)
                    // Shape only, never content: enough to tell a truncated, reasoning-only,
                    // or malformed response apart when a run misbehaves in the field.
                    Logger.warn(
                        `[SubagentRunner] Response without a tool call: kind=${failure.kind} stopReason=${roundStopReason ?? "unreported"} textChars=${assistantText.trim().length} reasoning=${assistantContent.some((block) => block.type === "thinking" || block.type === "redacted_thinking")} outputTokens=${requestUsage.outputTokens} nativeTools=${useNativeToolCalls} consecutive=${turnFailures.count}/${turnFailures.limit}`,
                    )
                    if (turnFailures.exhausted) return failAfterConsecutiveTurnFailures()
                    appendUserFeedback(conversation, turnFailureFeedback(failure))
                    await Promise.resolve()
                    continue
                }

                // One response is one failed attempt, however many of its calls were rejected.
                let responseFailureRecorded = false
                const recordResponseFailure = (kind: TurnFailureKind): string | undefined => {
                    if (responseFailureRecorded) return undefined
                    responseFailureRecorded = true
                    const failure: TurnFailure =
                        kind === "convergence_violation"
                            ? {
                                  kind,
                                  rejectedTools: finalizedToolCalls
                                      .map((call) => call.name)
                                      .filter((name) => name !== DlineDefaultTool.ATTEMPT),
                              }
                            : { kind }
                    turnFailures.record(failure)
                    return turnFailureFeedback(failure)
                }

                const toolResultBlocks = [] as ClineUserContent[]
                for (const call of finalizedToolCalls) {
                    const toolName = call.name as DlineDefaultTool
                    const toolCallParams = toToolUseParams(call.input)
                    const toolCallBlock: ToolUse = {
                        type: "tool_use",
                        name: toolName,
                        params: toolCallParams,
                        partial: false,
                        ts: Date.now(),
                        isNativeToolCall: call.isNativeToolCall,
                        function_id: call.function_id,
                        dline_tid: call.dline_tid,
                        signature: call.signature,
                    }
                    canonicalizeAttemptCompletionParams(toolCallBlock)

                    if (this.completionOnly && toolName !== DlineDefaultTool.ATTEMPT) {
                        const feedback = recordResponseFailure("convergence_violation")
                        if (turnFailures.exhausted) return failAfterConsecutiveTurnFailures()
                        pushSubagentToolResultBlock(
                            toolResultBlocks,
                            call,
                            toolName,
                            feedback ?? "Rejected: only attempt_completion is accepted now.",
                        )
                        continue
                    }

                    if (toolName === DlineDefaultTool.ATTEMPT) {
                        const completionResult = toolCallParams.result?.trim()
                        if (!completionResult) {
                            const feedback = recordResponseFailure("missing_completion_result")
                            if (turnFailures.exhausted) return failAfterConsecutiveTurnFailures()
                            pushSubagentToolResultBlock(
                                toolResultBlocks,
                                call,
                                toolName,
                                feedback ?? "Rejected: attempt_completion needs a non-empty result.",
                            )
                            continue
                        }

                        const boundedCompletionResult = truncateTextToSubagentOutputBudget(
                            completionResult,
                            resolveFinalResultTokens(outputBudget.outputTokens, this.activeBudget),
                        )
                        const latestToolCall = formatToolCallPreview(toolName, toolCallParams)
                        onProgress({
                            latestToolCall,
                            event: {
                                kind: "tool_call",
                                toolCallId: call.dline_tid,
                                toolName,
                                toolStatus: "completed",
                                summary: latestToolCall,
                            },
                        })
                        stats.toolCalls += 1
                        onProgress({ stats: { ...stats } })
                        onProgress({ status: "completed", result: boundedCompletionResult, stats: { ...stats } })
                        return { status: "completed", result: boundedCompletionResult, stats }
                    }

                    if (!this.allowedTools.includes(toolName)) {
                        const deniedResult = formatResponse.toolError(`Tool '${toolName}' is not available inside subagent runs.`)
                        pushSubagentToolResultBlock(toolResultBlocks, call, toolName, deniedResult)
                        continue
                    }

                    const latestToolCall = formatToolCallPreview(toolName, toolCallParams)
                    const toolStartedAt = Date.now()
                    onProgress({
                        latestToolCall,
                        event: {
                            kind: "tool_call",
                            toolCallId: call.dline_tid,
                            toolName,
                            toolStatus: "started",
                            summary: latestToolCall,
                        },
                    })

                    const toolLease = toolBudget.begin()
                    const subagentConfig = this.createSubagentTaskConfig(
                        state,
                        webToolsEnabled,
                        webSearchRoutingPlan,
                        imageGenerationService,
                        toolLease,
                    )
                    const handler = subagentConfig.coordinator.getHandler(toolName)
                    let toolResult: unknown
                    let toolError: string | undefined

                    if (!handler) {
                        toolError = `No handler registered for tool '${toolName}'.`
                        toolResult = formatResponse.toolError(toolError)
                    } else {
                        try {
                            let admission = subagentConfig.coordinator.prepareAdmission(
                                toolCallBlock,
                                {
                                    taskId: subagentConfig.taskId,
                                    cwd: subagentConfig.cwd,
                                    workspaceRoots: subagentConfig.workspaceManager?.getRoots().map((root) => root.path) ?? [
                                        subagentConfig.cwd,
                                    ],
                                    workspaceRootEntries: subagentConfig.workspaceManager
                                        ?.getRoots()
                                        .map((root) => ({ name: root.name || path.basename(root.path), path: root.path })),
                                    primaryWorkspaceRoot: subagentConfig.workspaceManager?.getPrimaryRoot()?.path,
                                    isMultiRootEnabled: subagentConfig.isMultiRootEnabled,
                                    settings: subagentConfig.autoApprovalSettings,
                                    blanket: {
                                        yoloMode: subagentConfig.yoloModeToggled,
                                        approveAll:
                                            subagentConfig.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled") ===
                                            true,
                                    },
                                    inheritsApproval: true,
                                },
                                () => handler.execute(subagentConfig, toolCallBlock).then(normalizeObservedToolExecutionResult),
                            )
                            if (admission.outcome === "admitted" && admission.confirm) admission = await admission.confirm()
                            if (admission.outcome === "rejected") {
                                throw new Error(admission.rejection.message)
                            }
                            if (admission.decision.kind !== "none" && admission.decision.kind !== "automatic") {
                                throw new Error(
                                    `Tool '${toolName}' requires ${admission.decision.kind} approval for ${admission.decision.scope}, which is unavailable inside a subagent run.`,
                                )
                            }
                            const run = admission.run
                            const observedResult = await this.executeToolWithInterruption(run)
                            toolResult = observedResult.response
                            if (observedResult.failure) toolError = serializeToolResult(observedResult.response)
                        } catch (error) {
                            // An interrupted wait is not a tool failure: fall through to the
                            // abort check below so the run reports `cancelled`.
                            if (error instanceof SubagentToolInterruptedError) {
                                const cancelError = "Subagent run cancelled."
                                onProgress({ status: "cancelled", error: cancelError, stats: { ...stats } })
                                return { status: "cancelled", error: cancelError, retryable: true, stats }
                            }
                            toolError = error instanceof Error ? error.message : String(error)
                            toolResult = formatResponse.toolError(toolError)
                        }
                    }

                    stats.toolCalls += 1
                    onProgress({ stats: { ...stats } })

                    if (!toolError) turnFailures.reset()
                    const serializedToolResult = serializeToolResult(toolResult)
                    const boundedToolResult = boundToolText(
                        { body: serializedToolResult },
                        { strategy: "headTail", ...resolveToolResultBudget(toolLease, MAX_TOOL_RESULT_TEXT_BYTES) },
                    )
                    toolLease.end(Buffer.byteLength(boundedToolResult, "utf8"))
                    onProgress({
                        event: {
                            kind: "tool_call",
                            toolCallId: call.dline_tid,
                            toolName,
                            toolStatus: toolError ? "failed" : "completed",
                            summary: latestToolCall,
                            durationMs: Date.now() - toolStartedAt,
                            error: toolError,
                        },
                    })
                    onProgress({
                        event: {
                            kind: "tool_result",
                            toolCallId: call.dline_tid,
                            toolName,
                            text: toolError ? undefined : serializedToolResult,
                            error: toolError,
                        },
                    })
                    const toolDescription = handler?.getDescription(toolCallBlock) || `[${toolName}]`
                    pushSubagentToolResultBlock(toolResultBlocks, call, toolDescription, boundedToolResult)

                    // Check for abort after each tool execution to exit early
                    if (this.shouldAbort()) {
                        await this.abort()
                        const error = "Subagent run cancelled."
                        onProgress({ status: "cancelled", error, stats: { ...stats } })
                        return { status: "cancelled", error, retryable: true, stats }
                    }
                }

                conversation.push({
                    role: "user",
                    content: toolResultBlocks,
                })

                await Promise.resolve()
            }
        } catch (error) {
            await activeHostedServerToolLifecycle?.finalizeOpen(
                this.shouldAbort() ? HOSTED_SERVER_TOOL_CANCELLED_REASON : HOSTED_SERVER_TOOL_STREAM_FAILED_REASON,
            )
            if (this.shouldAbort()) {
                const cancelledError = "Subagent run cancelled."
                onProgress({ status: "cancelled", error: cancelledError, stats: { ...stats } })
                return { status: "cancelled", error: cancelledError, retryable: true, stats }
            }

            const errorText = (error as Error).message || "Subagent execution failed."
            const retryable = this.shouldRetryStreamError(
                error,
                this.apiHandler.getProviderId?.() ?? DEFAULT_API_PROVIDER,
                this.apiHandler.getModel().id,
            )
            Logger.error("[SubagentRunner] run failed", error)
            onProgress({ status: "failed", error: errorText, stats: { ...stats } })
            return { status: "failed", error: errorText, retryable, stats }
        } finally {
            parentSignal?.removeEventListener("abort", onParentAbort)
            try {
                await activeHostedServerToolLifecycle?.finalizeOpen(HOSTED_SERVER_TOOL_STREAM_ENDED_REASON)
                // The run makes no further request, so nothing can resume what is still deferred.
                await activeHostedServerToolLifecycle?.failDeferred(HOSTED_SERVER_TOOL_DEFERRED_ABANDONED_REASON)
            } finally {
                this.activeApiAbort = undefined
                this.activeRetryAbortController = undefined
                this.interruptionController = undefined
                this.activeToolState = undefined
                this.inheritedOperationSignal = undefined
                this.running = false
            }
        }
    }

    /**
     * Resolve the web tool routes this subagent may use.
     *
     * Hosted tools are declared to the provider directly, bypassing the local tool
     * filter and tool admission, so each web tool the allowlist omits is withdrawn
     * from the plan here. Either allowed tool keeps the plan live, so a fetch-only
     * subagent still fetches.
     *
     * With XML tools the hosted routes are moved to the local executor first: an
     * XML-prompted model cannot call a native hosted tool, and the hosted route
     * would also withhold the local XML tool it can call. Localizing before the
     * allowlist withdrawals keeps the local fallback the withdrawals clear.
     */
    private resolveAllowedWebRoutingPlan(
        api: ApiHandler,
        webToolsEnabled: boolean,
        useNativeToolCalls: boolean,
    ): WebSearchRoutingPlan {
        const searchAllowed = this.allowedTools.includes(DlineDefaultTool.WEB_SEARCH)
        const fetchAllowed = this.allowedTools.includes(DlineDefaultTool.WEB_FETCH)
        const requested = resolveRequestWebSearchRoutingPlan(api, webToolsEnabled && (searchAllowed || fetchAllowed))
        const resolved = useNativeToolCalls ? requested : localizeHostedWebRoutes(requested)
        const withSearch = searchAllowed ? resolved : disableWebSearchRoute(resolved)
        return fetchAllowed ? withSearch : disableWebFetchRoute(withSearch)
    }

    private createSubagentTaskConfig(
        state: ToolHandlerState,
        webToolsEnabled: boolean,
        webSearchRoutingPlan: WebSearchRoutingPlan,
        imageGenerationService: TaskConfig["services"]["imageGenerationService"],
        contextBudget: TaskConfig["contextBudget"],
    ): TaskConfig {
        const baseCallbacks = this.baseConfig.callbacks
        const coordinator = new ToolExecutorCoordinator()
        const validator = new ToolValidator(this.baseConfig.services.ignoreController)

        for (const tool of this.allowedTools) {
            coordinator.registerByName(tool, validator)
        }

        return {
            ...this.baseConfig,
            api: this.apiHandler,
            coordinator,
            services: { ...this.baseConfig.services, imageGenerationService },
            taskState: state,
            isSubagentExecution: true,
            webToolsEnabled,
            webSearchRoutingPlan,
            vscodeTerminalExecutionMode: "backgroundExec",
            // The subagent's own budget, never the main task call's lease the
            // base configuration carries: these results fill the subagent's context.
            contextBudget,
            callbacks: {
                ...baseCallbacks,
                say: async () => undefined,
                sayUserReply: async () => undefined,
                sayAndCreateMissingParamError: async (_toolName, paramName) =>
                    formatResponse.toolError(formatResponse.missingToolParameterError(paramName)),
                executeCommandTool: async (command: string, timeoutSeconds: number | undefined, options) => {
                    this.activeCommandExecutions += 1
                    try {
                        return await baseCallbacks.executeCommandTool(command, timeoutSeconds, {
                            ...options,
                            useBackgroundExecution: true,
                            suppressUserInteraction: true,
                        })
                    } finally {
                        this.activeCommandExecutions = Math.max(0, this.activeCommandExecutions - 1)
                    }
                },
            },
        }
    }

    /** Use the same deny-list classifier as the main Task retry owner. */
    private shouldRetryStreamError(error: unknown, providerId: string, modelId: string): boolean {
        return isRetryableProviderError(error, { providerId, modelId })
    }

    private compactConversationForContextWindow(
        contextManager: ContextManager,
        conversation: ClineStorageMessage[],
        conversationHistoryDeletedRange: [number, number] | undefined,
    ): {
        didCompact: boolean
        conversationHistoryDeletedRange: [number, number] | undefined
    } {
        const optimizationResult = this.optimizeConversationForContextWindow(contextManager, conversation)
        let didCompact = optimizationResult.didOptimize
        let updatedDeletedRange = conversationHistoryDeletedRange

        if (optimizationResult.didOptimize && !optimizationResult.needToTruncate) {
            return {
                didCompact: true,
                conversationHistoryDeletedRange: updatedDeletedRange,
            }
        }

        const deletedRange = contextManager.getNextTruncationRange(conversation, conversationHistoryDeletedRange, "quarter")
        if (deletedRange[1] < deletedRange[0]) {
            return {
                didCompact,
                conversationHistoryDeletedRange: updatedDeletedRange,
            }
        }

        if (
            conversationHistoryDeletedRange &&
            deletedRange[0] === conversationHistoryDeletedRange[0] &&
            deletedRange[1] === conversationHistoryDeletedRange[1]
        ) {
            return {
                didCompact,
                conversationHistoryDeletedRange: updatedDeletedRange,
            }
        }

        updatedDeletedRange = deletedRange
        didCompact = true
        return {
            didCompact,
            conversationHistoryDeletedRange: updatedDeletedRange,
        }
    }

    private optimizeConversationForContextWindow(
        contextManager: ContextManager,
        conversation: ClineStorageMessage[],
    ): {
        didOptimize: boolean
        needToTruncate: boolean
    } {
        const timestamp = Date.now()
        const optimizationResult = contextManager.attemptFileReadOptimizationInMemory(conversation, undefined, timestamp)
        if (!optimizationResult.anyContextUpdates) {
            return { didOptimize: false, needToTruncate: true }
        }

        const optimizedConversation = optimizationResult.optimizedConversationHistory.map(
            (message) => message as ClineStorageMessage,
        )
        conversation.splice(0, conversation.length, ...optimizedConversation)
        return { didOptimize: true, needToTruncate: optimizationResult.needToTruncate }
    }

    private shouldCompactBeforeNextRequest(
        requestTotalTokens: number,
        api: ReturnType<typeof buildApiHandler>,
        modelId: string,
    ): boolean {
        const { contextWindow, maxAllowedSize } = getContextWindowInfo(api)
        const useAutoCondense = this.baseConfig.services.stateManager.getGlobalSettingsKey("useAutoCondense")
        if (useAutoCondense && isNextGenModelFamily(modelId)) {
            const thresholdTokens = computeCompactTrigger(contextWindow, computeSummarizeBudget(), {
                triggerPercent: this.baseConfig.services.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent"),
                minReserveTokens: this.baseConfig.services.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
                maxReserveTokens: this.baseConfig.services.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
                maxContextTokens: this.baseConfig.services.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
            })
            return shouldCompactProjectedUsage(requestTotalTokens, thresholdTokens)
        }

        return requestTotalTokens >= maxAllowedSize
    }

    private async *createMessageWithInitialChunkRetry(
        api: ReturnType<typeof buildApiHandler>,
        systemPrompt: string,
        fullConversation: ClineStorageMessage[],
        nativeTools: ClineTool[] | undefined,
        providerId: string,
        modelId: string,
        contextManager: ContextManager,
        contextState: SubagentContextState,
        roundContext: FrozenSubagentRoundContext | undefined,
        webSearchRoutingPlan: WebSearchRoutingPlan,
        onReplayableAttemptDiscarded: () => void,
        onProgress: (update: SubagentProgressUpdate) => void,
    ) {
        let cumulativeRetryDelayMs = 0
        const telemetryRequestId = `${this.providerRequestSource}:${this.apiLogRequestIndex + 1}`
        for (let attempt = 1; attempt <= MAX_INITIAL_STREAM_ATTEMPTS; attempt += 1) {
            // Only a pre-finish abort is expected; a later attempt is the finish turn and reports its real failure.
            const startedBeforeFinish = this.finishRequested === undefined
            const truncatedConversation = contextState.roundContexts.project(
                contextManager
                    .getTruncatedMessages(fullConversation, contextState.conversationHistoryDeletedRange)
                    .map((message) => message as ClineStorageMessage),
                contextState.conversationHistoryDeletedRange,
                roundContext,
            )
            const adapterRoundContext = {
                taskId: this.baseConfig.taskId,
                requestIndex: ++this.apiLogRequestIndex,
                provider: providerId,
                model: modelId,
                // Adapter logs stay coarse; semantic role is carried by the ApiHandler metadata below.
                source: "subagent" as const,
            }
            // Match the parent endpoint projection for hosted replay and native document input.
            const providerConversation = projectInternalMessagesForProvider(truncatedConversation, {
                hostedToolReplayProtocol: api.getHostedToolReplayProtocol?.(),
                documentInput: api.getDocumentInputLimits?.(),
            })
            await recordProviderAdapterInput(adapterRoundContext, {
                systemPrompt,
                messages: providerConversation,
                tools: nativeTools,
            })
            const stream = recordProviderAdapterOutput(
                adapterRoundContext,
                api.createMessage(systemPrompt, providerConversation, nativeTools, {
                    serverTools: webSearchRoutingPlan.serverTools,
                    taskNamespace: this.baseConfig.taskId,
                    retryOwner: "subagent",
                    telemetryRole: this.providerRequestSource,
                    telemetryRequestId,
                    telemetryAttempt: attempt - 1,
                }),
            )
            const iterator = stream[Symbol.asyncIterator]()
            const bufferedCommitChunks: Array<Extract<ApiProviderStreamChunk, { type: "usage" | "tool_calls" }>> = []
            let didYieldUnreplayableOutput = false
            try {
                while (true) {
                    const nextChunk = await iterator.next()
                    if (nextChunk.done) {
                        for (const bufferedChunk of bufferedCommitChunks) yield bufferedChunk
                        return
                    }
                    if (isAttemptCommitChunk(nextChunk.value)) {
                        // Native tool deltas have no business side effects until the complete
                        // response is finalized. Keep them before the normalizer so a failed
                        // attempt cannot pollute tool identity, parser or Session state.
                        bufferedCommitChunks.push(nextChunk.value)
                        continue
                    }
                    if (!producesUnreplayableOutput(nextChunk.value)) {
                        // Forward replayable scaffolding for live progress. The caller resets
                        // attempt-local accumulators if a retry discards the attempt.
                        yield nextChunk.value
                        continue
                    }

                    didYieldUnreplayableOutput = true
                    for (const bufferedChunk of bufferedCommitChunks) yield bufferedChunk
                    yield nextChunk.value
                    yield* { [Symbol.asyncIterator]: () => iterator }
                    return
                }
            } catch (error) {
                if (startedBeforeFinish && this.finishRequested && !this.shouldAbort()) {
                    if (!didYieldUnreplayableOutput) onReplayableAttemptDiscarded()
                    return
                }

                // Usage and content-free scaffolding remain replayable.
                // Once observable output exists, replay would duplicate content or tool lifecycles.
                if (didYieldUnreplayableOutput) {
                    throw error
                }

                if (checkContextWindowExceededError(error)) {
                    const compactResult = this.compactConversationForContextWindow(
                        contextManager,
                        fullConversation,
                        contextState.conversationHistoryDeletedRange,
                    )
                    contextState.conversationHistoryDeletedRange = compactResult.conversationHistoryDeletedRange
                    if (!compactResult.didCompact || this.shouldAbort() || attempt >= MAX_INITIAL_STREAM_ATTEMPTS) {
                        throw error
                    }
                    Logger.warn(
                        `[SubagentRunner] Context window exceeded on initial stream attempt ${attempt}; compacted conversation and retrying.`,
                    )
                    onReplayableAttemptDiscarded()
                    continue
                }

                const shouldRetry =
                    !this.shouldAbort() &&
                    attempt < MAX_INITIAL_STREAM_ATTEMPTS &&
                    this.shouldRetryStreamError(error, providerId, modelId)
                if (!shouldRetry) {
                    throw error
                }

                const delayMs = INITIAL_STREAM_RETRY_DELAYS_MS[attempt - 1]
                if (delayMs === undefined) throw error
                onReplayableAttemptDiscarded()
                cumulativeRetryDelayMs += delayMs
                onProgress({
                    event: {
                        kind: "retry",
                        retryAttempt: attempt,
                        maxRetries: INITIAL_STREAM_RETRY_DELAYS_MS.length,
                        delayMs,
                        cumulativeDelayMs: cumulativeRetryDelayMs,
                    },
                })
                Logger.warn(`[SubagentRunner] Initial stream failed. Retrying attempt ${attempt + 1} after ${delayMs}ms.`, error)
                try {
                    await waitForSubagentRetry(delayMs, this.activeRetryAbortController?.signal)
                } catch (waitError) {
                    if (startedBeforeFinish && this.finishRequested && !this.shouldAbort()) return
                    throw waitError
                }
            }
        }
    }
}
