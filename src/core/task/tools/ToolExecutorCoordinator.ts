import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { CLINE_MCP_TOOL_IDENTIFIER } from "@/shared/mcp"
import { ClineDefaultTool } from "@/shared/tools"
import { prepareRegisteredToolAdmission, type ToolAdmissionSnapshot } from "../executors/tool/ToolAdmissionRegistry"
import {
	rejectToolCall,
	type ToolApprovalPresentation,
	type ToolPreflightResult,
	type ToolSideEffect,
} from "../executors/tool/ToolPreflight"
import { AccessMcpResourceHandler } from "./handlers/AccessMcpResourceHandler"
import { ActModeRespondHandler } from "./handlers/ActModeRespondHandler"
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
import { QnaRespondHandler } from "./handlers/QnaRespondHandler"
import { ReadFileToolHandler } from "./handlers/ReadFileToolHandler"
import { RenameSymbolHandler } from "./handlers/RenameSymbolHandler"
import { ReplaceTextHandler } from "./handlers/ReplaceTextHandler"
import { ReportBugHandler } from "./handlers/ReportBugHandler"
import { SearchFilesToolHandler } from "./handlers/SearchFilesToolHandler"
import { SpawnTaskHandler } from "./handlers/SpawnTaskHandler"
import { StatusUpdateHandler } from "./handlers/StatusUpdateHandler"
import { restoreSubagentActivityRetry, UseSubagentsToolHandler, UseSubagentToolHandler } from "./handlers/SubagentToolHandler"
import { SummarizeTaskHandler } from "./handlers/SummarizeTaskHandler"
import { UseMcpToolHandler } from "./handlers/UseMcpToolHandler"
import { WebFetchToolHandler } from "./handlers/WebFetchToolHandler"
import { WebSearchToolHandler } from "./handlers/WebSearchToolHandler"
import { WriteToFileToolHandler } from "./handlers/WriteToFileToolHandler"
import type { ToolHandlerResult } from "./ToolExecutionResult"
import { ToolValidator } from "./ToolValidator"
import type { TaskConfig } from "./types/TaskConfig"
import type { StronglyTypedUIHelpers } from "./types/UIHelpers"

export interface IToolHandler {
	readonly name: ClineDefaultTool
	execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult>
	getDescription(block: ToolUse): string
}

export interface IPartialBlockHandler {
	handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void>
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
		public readonly name: ClineDefaultTool,
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
 * Coordinates tool execution by routing to registered handlers.
 * Falls back to legacy switch for unregistered tools.
 */
export class ToolExecutorCoordinator {
	private handlers = new Map<string, IToolHandler>()
	private readonly preparedHandlers = new Map<string, { handler: IPreparableToolHandler; block: ToolUse }>()

	private readonly toolHandlersMap: Record<ClineDefaultTool, (v: ToolValidator) => IToolHandler | undefined> = {
		[ClineDefaultTool.ASK]: (_v: ToolValidator) => new AskFollowupQuestionToolHandler(),
		[ClineDefaultTool.ATTEMPT]: (_v: ToolValidator) => new AttemptCompletionHandler(),
		[ClineDefaultTool.BASH]: (_v: ToolValidator) => new ExecuteCommandToolHandler(),
		[ClineDefaultTool.KILL_COMMAND]: (_v: ToolValidator) => new ExecuteCommandToolHandler(ClineDefaultTool.KILL_COMMAND),
		[ClineDefaultTool.FILE_EDIT]: (v: ToolValidator) =>
			new SharedToolHandler(ClineDefaultTool.FILE_EDIT, new WriteToFileToolHandler(v)),
		[ClineDefaultTool.FILE_READ]: (v: ToolValidator) => new ReadFileToolHandler(v),
		[ClineDefaultTool.FILE_NEW]: (v: ToolValidator) => new WriteToFileToolHandler(v),
		[ClineDefaultTool.SEARCH]: (v: ToolValidator) => new SearchFilesToolHandler(v),
		[ClineDefaultTool.LIST_FILES]: (v: ToolValidator) => new ListFilesToolHandler(v),
		[ClineDefaultTool.LIST_CODE_DEF]: (v: ToolValidator) => new ListCodeDefinitionNamesToolHandler(v),
		[ClineDefaultTool.BROWSER]: (_v: ToolValidator) => new BrowserToolHandler(),
		[ClineDefaultTool.MCP_USE]: (_v: ToolValidator) => new UseMcpToolHandler(),
		[ClineDefaultTool.MCP_ACCESS]: (_v: ToolValidator) => new AccessMcpResourceHandler(),
		[ClineDefaultTool.MCP_DOCS]: (_v: ToolValidator) => new LoadMcpDocumentationHandler(),
		[ClineDefaultTool.LOAD_MCP]: (_v: ToolValidator) => new LoadCapabilityHandler(ClineDefaultTool.LOAD_MCP, "mcp"),
		[ClineDefaultTool.LOAD_SKILL]: (_v: ToolValidator) => new LoadCapabilityHandler(ClineDefaultTool.LOAD_SKILL, "skill"),
		[ClineDefaultTool.LOAD_WORKFLOW]: (_v: ToolValidator) =>
			new LoadCapabilityHandler(ClineDefaultTool.LOAD_WORKFLOW, "workflow"),
		[ClineDefaultTool.NEW_TASK]: (_v: ToolValidator) => new NewTaskHandler(),
		[ClineDefaultTool.MAKE_PLAN]: (_v: ToolValidator) => new MakePlanHandler(),
		[ClineDefaultTool.ACT_MODE]: (_v: ToolValidator) => new ActModeRespondHandler(),
		[ClineDefaultTool.QNA_RESPOND]: (_v: ToolValidator) => new QnaRespondHandler(),
		[ClineDefaultTool.TODO]: (_v: ToolValidator) => undefined,
		[ClineDefaultTool.WEB_FETCH]: (_v: ToolValidator) => new WebFetchToolHandler(),
		[ClineDefaultTool.WEB_SEARCH]: (_v: ToolValidator) => new WebSearchToolHandler(),
		[ClineDefaultTool.CONDENSE]: (_v: ToolValidator) => undefined,
		[ClineDefaultTool.SUMMARIZE_TASK]: (_v: ToolValidator) => new SummarizeTaskHandler(_v),
		[ClineDefaultTool.REPORT_BUG]: (_v: ToolValidator) => new ReportBugHandler(),
		[ClineDefaultTool.NEW_RULE]: (v: ToolValidator) =>
			new SharedToolHandler(ClineDefaultTool.NEW_RULE, new WriteToFileToolHandler(v)),
		[ClineDefaultTool.APPLY_PATCH]: (_v: ToolValidator) => new ApplyPatchHandler(_v),
		[ClineDefaultTool.GENERATE_EXPLANATION]: (_v: ToolValidator) => new GenerateExplanationToolHandler(),
		[ClineDefaultTool.GENERATE_IMAGE]: (_v: ToolValidator) => new GenerateImageToolHandler(),
		[ClineDefaultTool.USE_SUBAGENT]: (_v: ToolValidator) => new UseSubagentToolHandler(),
		[ClineDefaultTool.USE_SUBAGENTS]: (_v: ToolValidator) => new UseSubagentsToolHandler(),
		[ClineDefaultTool.SPAWN_TASK]: (_v: ToolValidator) => new SpawnTaskHandler(),
		[ClineDefaultTool.GENERATE_REPORT]: (_v: ToolValidator) => new GenerateReportHandler(),
		[ClineDefaultTool.CHANGE_TODO_LIST]: (_v: ToolValidator) => new FocusChainHandler(),
		[ClineDefaultTool.FIND_REFERENCES]: (_v: ToolValidator) => new FindReferencesHandler(),
		[ClineDefaultTool.RENAME]: (_v: ToolValidator) => new RenameSymbolHandler(),
		[ClineDefaultTool.REPLACE_TEXT]: (_v: ToolValidator) => new ReplaceTextHandler(),
		[ClineDefaultTool.STATUS_UPDATE]: (_v: ToolValidator) => new StatusUpdateHandler(),
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

	registerByName(toolName: ClineDefaultTool, validator: ToolValidator): void {
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
		return prepareRegisteredToolAdmission({
			canonicalToolName: canonicalToolName as ClineDefaultTool,
			block,
			description: handler.getDescription(block),
			snapshot,
			snapshotProvider,
			run,
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
		return toolName.includes(CLINE_MCP_TOOL_IDENTIFIER) ? ClineDefaultTool.MCP_USE : toolName
	}

	/**
	 * Execute a tool through its registered handler
	 */
	async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
		const handler = this.getHandler(block.name)
		if (!handler) {
			throw new Error(`No handler registered for tool: ${block.name}`)
		}
		if (block.dline_tid) this.preparedHandlers.delete(block.dline_tid)
		return handler.execute(config, block)
	}
}
