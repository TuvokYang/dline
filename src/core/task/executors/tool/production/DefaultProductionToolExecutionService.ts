import type { ToolUse } from "@core/assistant-message"
import type { ContextBudgetLease, ContextBudgetLedger } from "@core/context/context-management/context-budget-ledger"
import { estimateContextValueBreakdown } from "@core/context/context-management/context-window-projection"
import { formatResponse } from "@core/prompts/responses"
import { boundToolText, MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import type { UiSayTool } from "@shared/ExtensionMessage"
import type { ClineToolResponseContent, ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { CONVERSATIONAL_TOOL_NAMES, DlineDefaultTool } from "@shared/tools"
import { serializeDurableToolResult, toolResultReplayOf } from "../../../DurableToolResult"
import { LOOP_DETECTION_SOFT_THRESHOLD, recordToolCall, toolCallSignature } from "../../../loop-detection"
import { ToolExecutionObservation, type ToolFailureObservation } from "../../../observability/tool-execution-observation"
import type { ToolInvocationEnvelope } from "../../../stores/payload/TaskPayloadEnvelopes"
import { approvalInteractionId } from "../../../tools/approval-interaction"
import { normalizeToolExecutionResult, type ToolPostCommitDirective } from "../../../tools/ToolExecutionResult"
import type { ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import type { TaskConfig } from "../../../tools/types/TaskConfig"
import { ToolDisplayUtils } from "../../../tools/utils/ToolDisplayUtils"
import { type ToolResultBudget, ToolResultUtils } from "../../../tools/utils/ToolResultUtils"
import { resolveToolResultBudget } from "../../../tools/utils/tool-result-budget"
import type { ProductionToolExecutionService } from "../ProductionToolAdapter"
import { reviewRegisteredToolBoundary, type ToolAdmissionSnapshot } from "../ToolAdmissionRegistry"
import type { ToolDomainSurface } from "../ToolDomainSurface"
import type { ToolRunCommand } from "../ToolExecutionDomain"
import type { ProductionToolHandlerRuntime } from "./ProductionToolHandlerRuntime"
import { resolveToolInteractionPolicy } from "./ToolInteractionPolicy"

export interface ProductionToolConfigFactoryInput {
    readonly command: ToolRunCommand
    readonly invocation: ToolInvocationEnvelope
    readonly surface: ToolDomainSurface
    readonly coordinator: ToolExecutorCoordinator
}

export interface ProductionToolConfigFactory {
    create(input: ProductionToolConfigFactoryInput): TaskConfig
    /** Value-only snapshot used by the post-approval canonical boundary review. */
    readAdmissionSnapshot(block: ToolUse): ToolAdmissionSnapshot
}

export interface DefaultProductionToolExecutionServiceOptions {
    readonly taskId: string
    readonly config: ProductionToolConfigFactory
    readonly runtime: ProductionToolHandlerRuntime
    /**
     * The task's context budget. Each call draws a share while it runs and
     * counts its result the moment it is produced, so parallel calls cannot
     * together overflow the conversation.
     */
    readonly contextBudget?: Pick<ContextBudgetLedger, "begin">
}

export interface ProductionToolExecutionResult {
    readonly content: string
    readonly failed?: boolean
    readonly failure?: ToolFailureObservation
    /** PDFs the user attached to the call's answer; they follow the result in the next request. */
    readonly documents?: readonly ClineUserAttachedDocumentBlock[]
    readonly postCommit?: ToolPostCommitDirective
}

function canFallbackUnadvertisedWebSearch(config: TaskConfig): boolean {
    const plan = config.webSearchRoutingPlan
    return (
        config.webToolsEnabled === true &&
        plan?.mode === WebToolsMode.WEB_TOOLS_MODE_AUTO &&
        plan.route === "hosted" &&
        plan.localFallbackAvailable &&
        config.coordinator.has(DlineDefaultTool.WEB_SEARCH)
    )
}

/**
 * Hand the call to the local engine. The fallback notice travels with it so the
 * local search, which settles the call's own row, also says why it ran.
 */
function createLocalWebSearchFallbackConfig(config: TaskConfig, notice: string): TaskConfig {
    const plan = config.webSearchRoutingPlan
    if (!plan) return config
    return {
        ...config,
        webSearchRoutingPlan: Object.freeze({
            ...plan,
            route: "local" as const,
            localToolEnabled: true,
            serverTools: Object.freeze([]),
        }),
        webSearchFallbackNotice: notice,
    }
}

function hostedSearchProvider(config: TaskConfig): { readonly id: string; readonly label: string } {
    const id = config.api.getProviderId?.() ?? "provider"
    return { id, label: id === "openai" ? "OpenAI" : id === "deepseek" ? "DeepSeek" : id }
}

/** What the user is told when a hosted search came back as a local function call. */
function unadvertisedHostedWebSearchMessage(config: TaskConfig, fallback: boolean, mode: WebToolsMode): string {
    const providerLabel = hostedSearchProvider(config).label
    return fallback
        ? `${providerLabel} hosted Web Search returned a local web_search function call instead of a hosted search event; falling back to Dline local Web Search.`
        : mode === WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE
          ? `${providerLabel} hosted Web Search returned a local web_search function call, but the request is configured for Force Remote. The local call was rejected.`
          : `${providerLabel} hosted Web Search returned a local web_search function call, but Auto mode has no Dline local Web Search fallback for the current prompt profile. The local call was rejected.`
}

/** End a hosted search call that cannot be answered locally on the call's own row. */
async function presentRejectedHostedWebSearch(config: TaskConfig, block: ToolUse, message: string): Promise<void> {
    const { id: providerId, label: providerLabel } = hostedSearchProvider(config)
    const query = typeof block.params?.query === "string" && block.params.query.trim() ? block.params.query.trim() : "Web search"
    const presentation: UiSayTool = {
        tool: "webSearch",
        path: query,
        content: `Web search routing failed: ${message}`,
        operationIsLocatedInWorkspace: false,
        webSearch: {
            schemaVersion: 1,
            status: "failed",
            source: {
                id: `${providerId}-hosted`,
                label: `${providerLabel} Web Search`,
                execution: "hosted",
                provider: providerId,
            },
            query,
            error: message,
        },
    }
    await config.callbacks.say("tool", JSON.stringify(presentation), undefined, undefined, false, block.ts)
}

/**
 * Show a refusal the call met after it was approved on the call's own row.
 *
 * The handler never runs, so nothing else would move the row its preview or
 * approval drew to a terminal state; a call that drew no row gets one appended.
 */
async function presentBoundaryRefusal(config: TaskConfig, block: ToolUse, message: string): Promise<void> {
    await config.callbacks.say("error", message, undefined, undefined, false, block.ts)
}

/**
 * Serialize what the call returned as the result the next request carries.
 *
 * A string result opens with the call's description, as main sends it: the
 * description names what the call acted on, so results with the same text -
 * two copies of one file - stay distinct to the model and to the prefix cache.
 */
function serializeResult(
    invocation: ToolInvocationEnvelope,
    response: ClineToolResponseContent,
    description: string,
    failure?: ToolFailureObservation,
    budget?: ToolResultBudget,
): SerializedToolResult {
    const described = typeof response === "string"
    const content = described
        ? ToolResultUtils.boundTextResult(description, response, budget)
        : ToolResultUtils.boundContent(response, budget)
    return {
        result: {
            content: serializeDurableToolResult(
                {
                    type: "tool_result",
                    function_id: invocation.functionId,
                    dline_tid: invocation.dlineTid,
                    content,
                    ...(failure ? { is_error: true } : {}),
                },
                toolResultReplayOf(invocation, described),
            ),
            ...(failure ? { failed: true, failure } : {}),
        },
        contentBytes: measureTextBytes(content),
        mediaTokens: measureMediaTokens(content),
    }
}

interface SerializedToolResult {
    readonly result: ProductionToolExecutionResult
    /** Text the next request carries for this result. */
    readonly contentBytes: number
    /** Images and documents the result carries, estimated by their own model rather than as text. */
    readonly mediaTokens: number
}

function measureMediaTokens(content: unknown): number {
    return typeof content === "string" ? 0 : estimateContextValueBreakdown(content).imageTokens
}

function measureTextBytes(content: ClineToolResponseContent): number {
    if (typeof content === "string") return Buffer.byteLength(content, "utf8")
    return content.reduce((total, block) => total + (block.type === "text" ? Buffer.byteLength(block.text, "utf8") : 0), 0)
}

/**
 * Tools whose result is worth keeping whole: a subagent result can be many
 * minutes of work, so when the conversation has no room left it waits for
 * compaction instead of being cut to a notice.
 */
const DEFERRABLE_TOOLS: ReadonlySet<string> = new Set([DlineDefaultTool.USE_SUBAGENT, DlineDefaultTool.USE_SUBAGENTS])

/**
 * The budget one call's result is bounded with.
 *
 * A conversational call returns what the user answered: input the task is
 * waiting on, not output a tool generated, and compaction keeps it as the turn
 * the user opened. Cutting it to the round's share would erase the reply
 * exactly when the context is full and compaction is about to run, so only the
 * absolute cap applies to it. Its bytes are still counted against the round.
 */
function resultBudgetOf(toolName: string, lease: ContextBudgetLease | undefined): ToolResultBudget | undefined {
    if (CONVERSATIONAL_TOOL_NAMES.has(toolName as DlineDefaultTool)) return undefined
    return resolveToolResultBudget(lease, MAX_TOOL_RESULT_TEXT_BYTES)
}

/** What the model receives in place of a result that waits for room; it pairs the call and lets the task go on. */
export function deferredResultNotice(description: string): string {
    return `[DEFERRED] ${description} result held: context budget below 3K. Continue the task; the result will be delivered after automatic compaction.`
}

function responseText(response: ClineToolResponseContent): string {
    if (typeof response === "string") return response
    return response.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
}

/** Rehydrate the canonical runtime tool block stored behind an invocation reference. */
export function materializeToolInvocation(invocation: ToolInvocationEnvelope): ToolUse {
    const params = Object.fromEntries(
        Object.entries(invocation.input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
    ) as ToolUse["params"]
    return {
        type: "tool_use",
        name: invocation.toolName as ToolUse["name"],
        params,
        partial: false,
        ts: invocation.presentationId,
        isNativeToolCall: invocation.isNativeToolCall,
        function_id: invocation.functionId,
        dline_tid: invocation.dlineTid,
        ...(invocation.signature === undefined ? {} : { signature: invocation.signature }),
    }
}

/**
 * Record a finished call with the repeated-call detector and apply its verdict.
 *
 * It runs after the handler because a successful handler resets the mistake
 * count; escalating afterwards keeps the limit latched for the next round, as in
 * dev. The soft warning rides on this call's own result because the runtime has
 * no separate user-content buffer to carry it. Detection is synchronous, so
 * concurrent calls cannot interleave between comparing and recording.
 */
export function applyRepeatedCallGuard(
    config: Pick<TaskConfig, "taskState" | "services">,
    block: Pick<ToolUse, "name" | "params">,
    response: ClineToolResponseContent,
): ClineToolResponseContent {
    const verdict = recordToolCall(config.taskState, block.name, toolCallSignature(block.params))
    if (verdict.hardEscalation) {
        config.taskState.consecutiveMistakeCount =
            config.services.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes") ?? 3
    }
    if (!verdict.softWarning) return response
    const warning = formatResponse.repeatedToolCall(block.name, LOOP_DETECTION_SOFT_THRESHOLD)
    return Array.isArray(response) ? [...response, { type: "text", text: warning }] : `${response}\n\n${warning}`
}

/** Task-scoped handler runtime with no dependency on the legacy ToolExecutor. */
export class DefaultProductionToolExecutionService implements ProductionToolExecutionService {
    constructor(private readonly options: DefaultProductionToolExecutionServiceOptions) {}

    async execute(input: {
        readonly command: ToolRunCommand
        readonly invocation: ToolInvocationEnvelope
        readonly surface: ToolDomainSurface
    }): Promise<ProductionToolExecutionResult> {
        const observation = new ToolExecutionObservation({
            taskId: this.options.taskId,
            toolName: input.invocation.toolName,
            turnId: input.command.turnId ?? "",
            native: input.invocation.isNativeToolCall,
        })
        return observation.run(() => this.executeObserved(input))
    }

    private async executeObserved(input: {
        readonly command: ToolRunCommand
        readonly invocation: ToolInvocationEnvelope
        readonly surface: ToolDomainSurface
    }): Promise<ProductionToolExecutionResult> {
        if (input.invocation.dlineTid !== input.command.dlineTid) {
            throw new Error(`ToolInvocationIdentityMismatch:${input.invocation.dlineTid}:${input.command.dlineTid}`)
        }
        const lease = this.options.contextBudget?.begin()
        let resultBytes = 0
        let mediaTokens = 0
        try {
            const serialized = await this.runBudgeted(input, lease)
            resultBytes = serialized.contentBytes
            mediaTokens = serialized.mediaTokens
            return serialized.result
        } finally {
            lease?.end(resultBytes, mediaTokens)
        }
    }

    private async runBudgeted(
        input: {
            readonly command: ToolRunCommand
            readonly invocation: ToolInvocationEnvelope
            readonly surface: ToolDomainSurface
        },
        lease: ContextBudgetLease | undefined,
    ): Promise<SerializedToolResult> {
        const block = materializeToolInvocation(input.invocation)
        const description = ToolDisplayUtils.getToolDescription(block, this.options.runtime.coordinator)
        let config: TaskConfig = {
            ...this.options.config.create({ ...input, coordinator: this.options.runtime.coordinator }),
            ...(lease ? { contextBudget: lease } : {}),
        }
        // Every terminal write of the call, including a refusal below, lands on its approval row.
        const approvalAnchor = config.messageState?.clineMessages.find(
            (message) => message.interactionId === approvalInteractionId(input.invocation.dlineTid),
        )
        if (approvalAnchor) block.ts = approvalAnchor.ts
        const boundary = await reviewRegisteredToolBoundary(
            block,
            block.name as DlineDefaultTool,
            this.options.config.readAdmissionSnapshot(block),
        )
        if (boundary.outcome === "rejected") {
            const message =
                boundary.code === "scope_widened"
                    ? formatResponse.toolScopeWidened()
                    : formatResponse.toolCanonicalizationFailed()
            await presentBoundaryRefusal(config, block, message)
            return serializeResult(input.invocation, formatResponse.toolError(message), description, {
                stage: "authorization",
                code: boundary.code,
            })
        }
        if (
            input.invocation.isNativeToolCall &&
            input.invocation.toolName === DlineDefaultTool.WEB_SEARCH &&
            config.webSearchRoutingPlan?.route === "hosted"
        ) {
            const fallback = canFallbackUnadvertisedWebSearch(config)
            const message = unadvertisedHostedWebSearchMessage(config, fallback, config.webSearchRoutingPlan.mode)
            if (!fallback) {
                await presentRejectedHostedWebSearch(config, block, message)
                return serializeResult(input.invocation, formatResponse.toolError(message), description, {
                    stage: "routing",
                    code: "hosted_fallback_unavailable",
                })
            }
            config = createLocalWebSearchFallbackConfig(config, message)
        }
        const policyResult = await resolveToolInteractionPolicy(config, block)
        const result = normalizeToolExecutionResult(
            policyResult === undefined ? await this.options.runtime.execute(config, block) : policyResult,
        )
        const response = await this.deferWithoutRoom(
            config,
            input.invocation,
            block,
            applyRepeatedCallGuard(config, block, result.response),
            description,
            result.failure === undefined ? lease : undefined,
        )
        // Read the share only now: results other calls returned while this one
        // ran have already been counted, so the share reflects what is left.
        const serialized = serializeResult(
            input.invocation,
            response,
            description,
            result.failure,
            resultBudgetOf(block.name, lease),
        )
        return {
            contentBytes: serialized.contentBytes,
            mediaTokens: serialized.mediaTokens + measureMediaTokens(result.documents ?? []),
            result: {
                ...serialized.result,
                ...(result.documents?.length ? { documents: result.documents } : {}),
                ...(result.postCommit === undefined ? {} : { postCommit: result.postCommit }),
            },
        }
    }

    /**
     * Hold a subagent result durably and answer the call with a notice while
     * less than the yield margin is left; the background delivery ledger
     * releases it once compaction makes room, also after a restart.
     */
    private async deferWithoutRoom(
        config: TaskConfig,
        invocation: ToolInvocationEnvelope,
        block: ToolUse,
        response: ClineToolResponseContent,
        description: string,
        lease: ContextBudgetLease | undefined,
    ): Promise<ClineToolResponseContent> {
        if (!lease || !DEFERRABLE_TOOLS.has(block.name) || !config.backgroundResults) return response
        if (!lease.snapshot().mustYield) return response
        await config.backgroundResults.publish({
            entryId: `background:subagent-deferred:${invocation.dlineTid}:attempt:1`,
            producerKind: block.name === DlineDefaultTool.USE_SUBAGENTS ? "subagent_batch" : "subagent",
            producerId: invocation.dlineTid,
            attempt: 1,
            // The same bound an inline result has: a fan-out's combined results
            // must not enter the conversation larger for having waited.
            text: boundToolText(
                {
                    header: [
                        "# Background Results",
                        "## Deferred Subagent Results",
                        `${description} (function_id ${invocation.functionId}) Result:`,
                    ].join("\n"),
                    body: responseText(response),
                },
                { strategy: "lines", maxBytes: MAX_TOOL_RESULT_TEXT_BYTES },
            ),
            acknowledge: () => undefined,
        })
        return deferredResultNotice(description)
    }

    /**
     * A restored retry runs a subagent again on the main task's behalf, so it
     * draws on the shared budget like the call that first started it.
     */
    async restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
        const lease = this.options.contextBudget?.begin()
        try {
            return await this.options.runtime.restoreSubagentRetry(
                lease ? { ...config, contextBudget: lease } : config,
                activityId,
            )
        } finally {
            lease?.end()
        }
    }
}
