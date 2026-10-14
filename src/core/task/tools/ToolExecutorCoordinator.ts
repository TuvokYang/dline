import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { CLINE_MCP_TOOL_IDENTIFIER } from "@/shared/mcp"
import { DlineDefaultTool } from "@/shared/tools"
import { prepareRegisteredToolAdmission, type ToolAdmissionSnapshot } from "../executors/tool/ToolAdmissionRegistry"
import type { ToolApprovalPresentation, ToolPreflightResult, ToolSideEffect } from "../executors/tool/ToolPreflight"
import { rejectToolCall } from "../executors/tool/ToolPreflight"
import {
    authorizeExplicitToolExecution,
    explicitToolRefusalMessage,
    findHandlerlessExplicitRefusal,
} from "../explicit-instructions/explicit-tool-gate"
import type { ExplicitInstructionFailureCode } from "../explicit-instructions/types"
import { ToolExecutionObservation } from "../observability/tool-execution-observation"
import { AccessMcpResourceHandler } from "./handlers/AccessMcpResourceHandler"
import { ApplyPatchHandler } from "./handlers/ApplyPatchHandler"
import { AskFollowupQuestionToolHandler } from "./handlers/AskFollowupQuestionToolHandler"
import { AttemptCompletionHandler } from "./handlers/AttemptCompletionHandler"
import { BrowserToolHandler } from "./handlers/BrowserToolHandler"
import { ExecuteCommandToolHandler } from "./handlers/ExecuteCommandToolHandler"
import { FindReferencesHandler } from "./handlers/FindReferencesHandler"
import { FocusChainHandler } from "./handlers/FocusChainHandler"
import { GenerateExplanationToolHandler } from "./handlers/GenerateExplanationToolHandler"
import { GenerateImageToolHandler } from "./handlers/GenerateImageToolHandler"
import { GenerateReportHandler } from "./handlers/GenerateReportHandler"
import { ListCodeDefinitionNamesToolHandler } from "./handlers/ListCodeDefinitionNamesToolHandler"
import { ListFilesToolHandler } from "./handlers/ListFilesToolHandler"
import { LoadCapabilityHandler } from "./handlers/LoadCapabilityHandler"
import { LoadMcpDocumentationHandler } from "./handlers/LoadMcpDocumentationHandler"
import { MakePlanHandler } from "./handlers/MakePlanHandler"
import { NewTaskHandler } from "./handlers/NewTaskHandler"
import { PhaseReportHandler } from "./handlers/PhaseReportHandler"
import { QnaRespondHandler } from "./handlers/QnaRespondHandler"
import { ReadFileToolHandler } from "./handlers/ReadFileToolHandler"
import { RenameSymbolHandler } from "./handlers/RenameSymbolHandler"
import { ReplaceTextHandler } from "./handlers/ReplaceTextHandler"
import { ReportBugHandler } from "./handlers/ReportBugHandler"
import { SearchFilesToolHandler } from "./handlers/SearchFilesToolHandler"
import { SpawnTaskHandler } from "./handlers/SpawnTaskHandler"
import { restoreSubagentActivityRetry, UseSubagentsToolHandler, UseSubagentToolHandler } from "./handlers/SubagentToolHandler"
import { UseMcpToolHandler } from "./handlers/UseMcpToolHandler"
import { WebFetchToolHandler } from "./handlers/WebFetchToolHandler"
import { WebSearchToolHandler } from "./handlers/WebSearchToolHandler"
import { WorkingRespondHandler } from "./handlers/WorkingRespondHandler"
import { WriteToFileToolHandler } from "./handlers/WriteToFileToolHandler"
import { applyToolCallSideEffects, awaitToolCallPreconditions, resolveToolCallSideEffects } from "./ToolCallSideEffects"
import type { ToolHandlerResult } from "./ToolExecutionResult"
import { ToolValidator } from "./ToolValidator"
import type { TaskConfig } from "./types/TaskConfig"
import type { StronglyTypedUIHelpers } from "./types/UIHelpers"

export interface IToolHandler {
    readonly name: DlineDefaultTool
    execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult>
    getDescription(block: ToolUse): string
}

export interface IPartialBlockHandler {
    handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void>
}

/** A handler that owns the typed payload shown before its side effect is admitted. */
export interface IApprovalPresentingToolHandler extends IToolHandler {
    getApprovalPresentation(block: ToolUse, notify: boolean): ToolApprovalPresentation
}

/**
 * A handler that can explain what a user rejection left behind.
 *
 * The driver owns the generic denial wording, but only the handler knows
 * whether its target survived unchanged, so it may extend that wording.
 */
export interface IDenialDescribingToolHandler extends IToolHandler {
    describeDenial(config: TaskConfig, block: ToolUse): Promise<string>
}

/**
 * A handler that owns how its own row looks once the user refuses it.
 *
 * `describeDenial` tells the model what the refusal left behind; this reports
 * the same fact to the user. Both stay with the handler because only it knows
 * which row it created and which terminal state that row should show.
 *
 * An implementation must locate its row by the block's canonical identity. A
 * turn can hold several rows of the same kind, so searching for the most recent
 * one would retitle a sibling that is still awaiting its own answer.
 */
export interface IDenialPresentingToolHandler extends IToolHandler {
    presentDenial(config: TaskConfig, block: ToolUse): Promise<void>
}

export type ToolHandlerPreparationResult =
    | { outcome: "prepared"; presentation: ToolApprovalPresentation }
    | { outcome: "rejected"; message: string }

export interface IPreparableToolHandler extends IToolHandler {
    prepare(config: TaskConfig, block: ToolUse): Promise<ToolHandlerPreparationResult>
    discardPrepared(block: ToolUse): void
}

export interface IFullyManagedTool extends IToolHandler, IPartialBlockHandler {
    // Legacy marker name retained for compatibility; partial methods are presentation-only.
}

/**
 * A wrapper class that allows a single tool handler to be registered under multiple names.
 * This provides proper typing for tools that share the same implementation logic.
 */
export class SharedToolHandler implements IFullyManagedTool {
    constructor(
        public readonly name: DlineDefaultTool,
        private baseHandler: IFullyManagedTool,
    ) {}

    getDescription(block: ToolUse): string {
        return this.baseHandler.getDescription(block)
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        return this.baseHandler.execute(config, block)
    }

    async describeDenial(config: TaskConfig, block: ToolUse): Promise<string> {
        return describeToolDenial(this.baseHandler, config, block)
    }

    async presentDenial(config: TaskConfig, block: ToolUse): Promise<void> {
        await presentToolDenial(this.baseHandler, config, block)
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        return this.baseHandler.handlePartialBlock(block, uiHelpers)
    }
}

/** Resolve the denial wording a handler reports, falling back to the generic denial. */
export async function describeToolDenial(handler: IToolHandler | undefined, config: TaskConfig, block: ToolUse): Promise<string> {
    if (handler && "describeDenial" in handler) {
        return (handler as IDenialDescribingToolHandler).describeDenial(config, block)
    }
    return formatResponse.toolDenied()
}

/**
 * Let a handler move its own row to a refused terminal state.
 *
 * Most tools present a refusal through the generic denial row and opt out by
 * not implementing this, so an absent hook is the normal case rather than a
 * missing one.
 */
export async function presentToolDenial(handler: IToolHandler | undefined, config: TaskConfig, block: ToolUse): Promise<void> {
    if (handler && "presentDenial" in handler) {
        await (handler as IDenialPresentingToolHandler).presentDenial(config, block)
        return
    }
    await withdrawUnsettledCard(config, block)
}

/**
 * Remove the card a refused call drew while it streamed.
 *
 * The call never ran and the generic denial row reports the refusal, so a card
 * still marked partial would otherwise keep spinning beside it forever. A card
 * its handler already settled is left alone.
 */
async function withdrawUnsettledCard(config: TaskConfig, block: ToolUse): Promise<void> {
    const card = config.messageState?.clineMessages.find((message) => message.ts === block.ts)
    if (card?.partial !== true) return
    await config.messageState.removeMessagesByTs([block.ts])
}

/**
 * Coordinates tool execution by routing to registered handlers.
 * Falls back to legacy switch for unregistered tools.
 */
export class ToolExecutorCoordinator {
    private handlers = new Map<string, IToolHandler>()
    private readonly preparedHandlers = new Map<string, { handler: IPreparableToolHandler; block: ToolUse }>()

    private readonly toolHandlersMap: Record<DlineDefaultTool, (v: ToolValidator) => IToolHandler | undefined> = {
        [DlineDefaultTool.ASK]: (_v: ToolValidator) => new AskFollowupQuestionToolHandler(),
        [DlineDefaultTool.ATTEMPT]: (_v: ToolValidator) => new AttemptCompletionHandler(),
        [DlineDefaultTool.BASH]: (_v: ToolValidator) => new ExecuteCommandToolHandler(),
        [DlineDefaultTool.KILL_COMMAND]: (_v: ToolValidator) => new ExecuteCommandToolHandler(DlineDefaultTool.KILL_COMMAND),
        [DlineDefaultTool.FILE_EDIT]: (v: ToolValidator) =>
            new SharedToolHandler(DlineDefaultTool.FILE_EDIT, new WriteToFileToolHandler(v)),
        [DlineDefaultTool.FILE_READ]: (v: ToolValidator) => new ReadFileToolHandler(v),
        [DlineDefaultTool.FILE_NEW]: (v: ToolValidator) => new WriteToFileToolHandler(v),
        [DlineDefaultTool.SEARCH]: (v: ToolValidator) => new SearchFilesToolHandler(v),
        [DlineDefaultTool.LIST_FILES]: (v: ToolValidator) => new ListFilesToolHandler(v),
        [DlineDefaultTool.LIST_CODE_DEF]: (v: ToolValidator) => new ListCodeDefinitionNamesToolHandler(v),
        [DlineDefaultTool.BROWSER]: (_v: ToolValidator) => new BrowserToolHandler(),
        [DlineDefaultTool.MCP_USE]: (_v: ToolValidator) => new UseMcpToolHandler(),
        [DlineDefaultTool.MCP_ACCESS]: (_v: ToolValidator) => new AccessMcpResourceHandler(),
        [DlineDefaultTool.MCP_DOCS]: (_v: ToolValidator) => new LoadMcpDocumentationHandler(),
        [DlineDefaultTool.LOAD_MCP]: (_v: ToolValidator) => new LoadCapabilityHandler(DlineDefaultTool.LOAD_MCP, "mcp"),
        [DlineDefaultTool.LOAD_SKILL]: (_v: ToolValidator) => new LoadCapabilityHandler(DlineDefaultTool.LOAD_SKILL, "skill"),
        [DlineDefaultTool.LOAD_WORKFLOW]: (_v: ToolValidator) =>
            new LoadCapabilityHandler(DlineDefaultTool.LOAD_WORKFLOW, "workflow"),
        [DlineDefaultTool.NEW_TASK]: (_v: ToolValidator) => new NewTaskHandler(),
        [DlineDefaultTool.MAKE_PLAN]: (_v: ToolValidator) => new MakePlanHandler(),
        [DlineDefaultTool.WORKING_RESPOND]: (_v: ToolValidator) => new WorkingRespondHandler(),
        // Former name; canonicalToolName() routes recorded calls to working_respond.
        [DlineDefaultTool.LEGACY_ACT_MODE_RESPOND]: (_v: ToolValidator) => undefined,
        [DlineDefaultTool.QNA_RESPOND]: (_v: ToolValidator) => new QnaRespondHandler(),
        [DlineDefaultTool.TODO]: (_v: ToolValidator) => undefined,
        [DlineDefaultTool.WEB_FETCH]: (_v: ToolValidator) => new WebFetchToolHandler(),
        [DlineDefaultTool.WEB_SEARCH]: (_v: ToolValidator) => new WebSearchToolHandler(),
        [DlineDefaultTool.CONDENSE]: (_v: ToolValidator) => undefined,
        // Compaction summaries arrive as explicit-instruction text owned by ContextCompactionSession, never as a tool call.
        [DlineDefaultTool.SUMMARIZE_TASK]: (_v: ToolValidator) => undefined,
        [DlineDefaultTool.REPORT_BUG]: (_v: ToolValidator) => new ReportBugHandler(),
        [DlineDefaultTool.NEW_RULE]: (v: ToolValidator) =>
            new SharedToolHandler(DlineDefaultTool.NEW_RULE, new WriteToFileToolHandler(v)),
        [DlineDefaultTool.APPLY_PATCH]: (_v: ToolValidator) => new ApplyPatchHandler(_v),
        [DlineDefaultTool.GENERATE_EXPLANATION]: (_v: ToolValidator) => new GenerateExplanationToolHandler(),
        [DlineDefaultTool.GENERATE_IMAGE]: (_v: ToolValidator) => new GenerateImageToolHandler(),
        [DlineDefaultTool.USE_SUBAGENT]: (_v: ToolValidator) => new UseSubagentToolHandler(),
        [DlineDefaultTool.USE_SUBAGENTS]: (_v: ToolValidator) => new UseSubagentsToolHandler(),
        [DlineDefaultTool.SPAWN_TASK]: (_v: ToolValidator) => new SpawnTaskHandler(),
        [DlineDefaultTool.GENERATE_REPORT]: (_v: ToolValidator) => new GenerateReportHandler(),
        [DlineDefaultTool.CHANGE_TODO_LIST]: (_v: ToolValidator) => new FocusChainHandler(),
        [DlineDefaultTool.FIND_REFERENCES]: (_v: ToolValidator) => new FindReferencesHandler(),
        [DlineDefaultTool.RENAME]: (_v: ToolValidator) => new RenameSymbolHandler(),
        [DlineDefaultTool.REPLACE_TEXT]: (_v: ToolValidator) => new ReplaceTextHandler(),
        [DlineDefaultTool.PHASE_REPORT]: (_v: ToolValidator) => new PhaseReportHandler(),
        // Former name; canonicalToolName() routes recorded calls to phase_report.
        [DlineDefaultTool.LEGACY_STATUS_UPDATE]: (_v: ToolValidator) => undefined,
    }

    /**
     * Register a tool handler
     */
    register(handler: IToolHandler): void {
        this.handlers.set(handler.name, handler)
    }

    async restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
        return restoreSubagentActivityRetry(config, activityId)
    }

    registerByName(toolName: DlineDefaultTool, validator: ToolValidator): void {
        const handler = this.toolHandlersMap[toolName]?.(validator)
        if (handler) {
            this.register(handler)
        }
    }

    /**
     * Check if a handler is registered for the given tool
     */
    has(toolName: string): boolean {
        return this.getHandler(toolName) !== undefined
    }

    /**
     * Get a handler for the given tool name
     */
    getHandler(toolName: string): IToolHandler | undefined {
        const staticHandler = this.handlers.get(this.canonicalToolName(toolName))
        if (staticHandler) {
            return staticHandler
        }

        return undefined
    }

    /** Present one incomplete tool block without admitting or executing it. */
    async presentPartial(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const handler = this.getHandler(block.name)
        if (!handler || !("handlePartialBlock" in handler)) return
        await (handler as IPartialBlockHandler).handlePartialBlock(block, uiHelpers)
    }

    /** Prepare one registry-owned admission without starting the handler. */
    prepareAdmission<T>(
        block: ToolUse,
        snapshot: ToolAdmissionSnapshot,
        run: ToolSideEffect<T>,
        snapshotProvider?: () => ToolAdmissionSnapshot,
    ): ToolPreflightResult<T> {
        const canonicalToolName = this.canonicalToolName(block.name)
        const handler = this.handlers.get(canonicalToolName)
        if (!handler) {
            return rejectToolCall({
                reason: "unsupported_tool",
                message: `No handler registered for tool: ${block.name}`,
            })
        }
        const presentation =
            "getApprovalPresentation" in handler
                ? (handler as IApprovalPresentingToolHandler).getApprovalPresentation(
                      block,
                      snapshot.settings.enableNotifications,
                  )
                : undefined
        const observedRun = snapshot.inheritsApproval
            ? () =>
                  new ToolExecutionObservation({
                      taskId: snapshot.taskId,
                      toolName: canonicalToolName,
                      turnId: "",
                      native: false,
                      scope: "subagent",
                      parent: "ambient",
                  }).run(run)
            : run
        return prepareRegisteredToolAdmission({
            canonicalToolName: canonicalToolName as DlineDefaultTool,
            block,
            description: handler.getDescription(block),
            snapshot,
            snapshotProvider,
            presentation,
            run: observedRun,
        })
    }

    async prepareExecution(config: TaskConfig, block: ToolUse): Promise<ToolHandlerPreparationResult | undefined> {
        const handler = this.getHandler(block.name)
        if (!handler || !("prepare" in handler) || !("discardPrepared" in handler)) return undefined
        const preparation = await (handler as IPreparableToolHandler).prepare(config, block)
        if (preparation.outcome === "prepared" && block.dline_tid) {
            this.preparedHandlers.set(block.dline_tid, { handler: handler as IPreparableToolHandler, block })
        }
        return preparation
    }

    discardPreparedExecution(dlineTid: string): void {
        const prepared = this.preparedHandlers.get(dlineTid)
        if (!prepared) return
        this.preparedHandlers.delete(dlineTid)
        prepared.handler.discardPrepared(prepared.block)
    }

    /** Registered names exposed for exhaustive admission coverage tests. */
    getRegisteredToolNames(): string[] {
        return Array.from(this.handlers.keys())
    }

    private canonicalToolName(toolName: string): string {
        if (toolName.includes(CLINE_MCP_TOOL_IDENTIFIER)) return DlineDefaultTool.MCP_USE
        // act_mode_respond was renamed to working_respond; calls recorded under the old name
        // (history replay, restored turns, XML output) keep the same non-blocking behavior.
        if (toolName === DlineDefaultTool.LEGACY_ACT_MODE_RESPOND) return DlineDefaultTool.WORKING_RESPOND
        // status_update was renamed to phase_report in the same way.
        if (toolName === DlineDefaultTool.LEGACY_STATUS_UPDATE) return DlineDefaultTool.PHASE_REPORT
        return toolName
    }

    /**
     * Execute a tool through its registered handler
     */
    async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        const handler = this.getHandler(block.name)
        if (!handler) {
            const refusal = findHandlerlessExplicitRefusal(block.name, config.explicitInstructions)
            if (refusal) return formatResponse.toolError(explicitToolRefusalMessage(block.name, refusal))
            throw new Error(`No handler registered for tool: ${block.name}`)
        }
        if (block.dline_tid) this.preparedHandlers.delete(block.dline_tid)
        const authorized = this.authorize(config, handler.name)
        if (!authorized.ok) {
            // The code is what the model reads back, so it can tell a missing grant
            // from a spent one instead of retrying a call that can never run.
            return formatResponse.toolError(explicitToolRefusalMessage(block.name, authorized.code))
        }
        // Effects that ride on a call without belonging to any tool. The surface
        // decides which of them it has, so a task with no checklist and no
        // workspace history runs the same tools without supplying either.
        const effects = resolveToolCallSideEffects(config)
        await awaitToolCallPreconditions(effects, handler.name)
        const result = await handler.execute(authorized.config, block)
        await applyToolCallSideEffects(effects, block, handler.name)
        return result
    }

    /**
     * Consume the turn's one-shot authority for an explicit-only tool.
     *
     * The gate runs once per invocation so a handler that requires explicit
     * authorization sees exactly one consumed authorization. A refusal stops the
     * call here, before the handler or any of its effects: an explicit-only tool
     * the user never asked for must not run on the strength of the model alone.
     */
    private authorize(
        config: TaskConfig,
        tool: DlineDefaultTool,
    ):
        | { readonly ok: true; readonly config: TaskConfig }
        | { readonly ok: false; readonly code: ExplicitInstructionFailureCode } {
        const gated = authorizeExplicitToolExecution(tool, config.explicitInstructions)
        if (!gated.ok) return { ok: false, code: gated.code }
        if (!gated.authorization) return { ok: true, config }
        return { ok: true, config: { ...config, explicitInstructionAuthorization: gated.authorization } }
    }
}
