import { randomUUID } from "node:crypto"
import type { Controller } from "@core/controller"
import { executeHook } from "@core/hooks/hook-executor"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { formatResponse } from "@core/prompts/responses"
import type { StateManager } from "@core/storage/StateManager"
import { FocusChainManager } from "@core/task/focus-chain"
import type { InteractionKind } from "@core/task/interaction/Interaction"
import type { MessageStateHandler } from "@core/task/message-state"
import type { TaskApiHandlerOwner } from "@core/task/session/TaskApiHandlerOwner"
import type { TaskInteractionOwner } from "@core/task/session/TaskInteractionOwner"
import type { DefaultToolHandlerState } from "@core/task/tools/state/ToolHandlerState"
import type { TaskCallbacks } from "@core/task/tools/types/TaskConfig"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import { BrowserSession } from "@services/browser/BrowserSession"
import type { ClineAsk, ClineMessage, ClineSay } from "@shared/ExtensionMessage"
import type { ClineContent } from "@shared/messages/content"
import type { ClineDefaultTool } from "@shared/tools"
import type { ClineAskResponse } from "@shared/WebviewMessage"

export interface ControllerTaskCallbacksOwnerOptions {
	readonly controller: Controller
	readonly taskId: string
	readonly stateManager: StateManager
	readonly messages: MessageStateHandler
	readonly interactions: TaskInteractionOwner
	readonly api: TaskApiHandlerOwner
	readonly toolState: DefaultToolHandlerState
	readonly createBrowser: () => BrowserSession
}

function interactionKind(type: ClineAsk | string): InteractionKind {
	switch (type) {
		case "tool":
			return "tool_approval"
		case "command":
		case "command_output":
			return "command_approval"
		case "browser_action_launch":
			return "browser_approval"
		case "use_mcp_server":
			return "mcp_approval"
		case "use_subagents":
			return "subagent_approval"
		case "spawn_task":
			return "spawn_task_approval"
		case "change_todo_list":
			return "change_todo_list"
		case "new_task":
			return "new_task"
		case "report_bug":
			return "report_bug"
		case "condense":
			return "condense"
		case "make_plan":
			return "make_plan"
		case "qna_respond":
			return "qna_response"
		case "generate_report":
			return "generate_report"
		case "status_acknowledgment":
			return "status_acknowledgment"
		case "api_req_failed":
			return "error_retry"
		case "mistake_limit_reached":
			return "mistake_limit"
		case "completion_result":
		case "resume_completed_task":
			return "completion"
		case "resume_task":
			return "resume"
		default:
			return "followup"
	}
}

function legacyResponse(actionId: string): ClineAskResponse {
	if (actionId === "approve" || actionId === "acknowledge" || actionId === "resume" || actionId === "retry") {
		return "yesButtonClicked"
	}
	if (actionId === "reject" || actionId === "stop") return "noButtonClicked"
	return "messageResponse"
}

/** Owns tool callback behavior without expanding the Task facade. */
export class ControllerTaskCallbacksOwner {
	readonly callbacks: TaskCallbacks
	private commandExecutor?: CommandExecutor
	private checkpointManager?: ICheckpointManager
	private browser: BrowserSession
	private readonly focusChain: FocusChainManager

	constructor(private readonly options: ControllerTaskCallbacksOwnerOptions) {
		this.browser = options.createBrowser()
		this.focusChain = new FocusChainManager({
			taskId: options.taskId,
			taskState: options.toolState,
			getMode: () => options.controller.task?.owners.settings.mode ?? "plan",
			stateManager: options.stateManager,
			postStateToWebview: () => options.controller.postStateToWebview(),
			say: (...args) => this.say(...args),
			focusChainSettings: options.stateManager.getGlobalSettingsKey("focusChainSettings"),
		})
		this.callbacks = {
			say: (...args) => this.say(...args),
			ask: (...args) => this.ask(...args),
			focusChainForceUpdate: (plan) => this.focusChain.forceReplaceFocusChain(plan),
			saveCheckpoint: (completion, ts) => this.checkpointManager?.saveCheckpoint(completion, ts) ?? Promise.resolve(),
			sayAndCreateMissingParamError: (tool, param, relPath, ts) => this.missingParameter(tool, param, relPath, ts),
			executeCommandTool: (command, timeout, executionOptions) =>
				this.requireCommandExecutor().execute(command, timeout, executionOptions),
			killCommandTool: (functionId) => this.requireCommandExecutor().cancelCommandByFunctionId(functionId),
			cancelRunningCommandTool: () => this.requireCommandExecutor().cancelBackgroundCommand(),
			doesLatestTaskCompletionHaveNewChanges: () =>
				this.checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
			updateFCListFromToolResponse: (progress) => this.focusChain.updateFCListFromToolResponse(progress),
			postStateToWebview: () => options.controller.postStateToWebview(),
			reinitExistingTaskFromId: (taskId) => options.controller.reinitExistingTaskFromId(taskId),
			cancelTask: () => options.controller.cancelTask(),
			updateTaskHistory: (update) => options.controller.updateTaskHistory(update as never),
			applyLatestBrowserSettings: () => this.applyLatestBrowserSettings(),
			switchToActMode: () => options.controller.togglePlanActMode("act"),
			setActiveHookExecution: async (execution) => {
				options.toolState.activeHookExecution = execution
				await options.controller.postStateToWebview()
			},
			clearActiveHookExecution: async () => {
				options.toolState.activeHookExecution = undefined
				await options.controller.postStateToWebview()
			},
			getActiveHookExecution: async () => options.toolState.activeHookExecution,
			runUserPromptSubmitHook: (content, context) => this.runUserPromptSubmitHook(content, context),
			updateClineMessage: (index, updates) => options.messages.updateClineMessage(index, updates),
		}
	}

	get browserSession(): BrowserSession {
		return this.browser
	}

	bindCommandExecutor(commandExecutor: CommandExecutor): void {
		this.commandExecutor = commandExecutor
	}

	bindCheckpointManager(checkpointManager: ICheckpointManager | undefined): void {
		this.checkpointManager = checkpointManager
	}

	async initialize(): Promise<void> {
		await this.focusChain.setupFocusChainFileWatcher()
	}

	async dispose(): Promise<void> {
		this.focusChain.dispose()
		await this.browser.dispose()
	}

	private async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		existingTs?: number,
		commandTs?: number,
	): Promise<number> {
		const ts = existingTs ?? Date.now()
		// commandTs is how a command_output row finds the command it belongs to;
		// dropping it here leaves the output orphaned and never rendered.
		const message: ClineMessage = { ts, type: "say", say: type, text, images, files, partial, commandTs }
		if (partial) await this.options.messages.upsertClineMessageInMemory(message)
		else if (this.options.messages.clineMessages.some((candidate) => candidate.ts === ts))
			await this.options.messages.finalizeClineMessage(message)
		else await this.options.messages.addToClineMessages(message)
		return ts
	}

	private async ask(
		type: ClineAsk,
		text?: string,
		_partial?: boolean,
		options?: { existingTs?: number; onTsCreated?: (ts: number) => void },
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[]; files?: string[] }> {
		const ts = options?.existingTs ?? Date.now()
		options?.onTsCreated?.(ts)
		const interactionId = `host:${randomUUID()}`
		const outcome = await this.options.interactions.open({
			turnId: `turn:${interactionId}`,
			interactionId,
			kind: interactionKind(type),
			presentation: text ?? "",
			existingTs: ts,
		})
		return {
			response: legacyResponse(outcome.actionId),
			text: outcome.draft?.text,
			images: outcome.draft?.images,
			files: outcome.draft?.files,
		}
	}

	private async missingParameter(_toolName: ClineDefaultTool, paramName: string, relPath?: string, existingTs?: number) {
		const message = `${formatResponse.missingToolParameterError(paramName)}${relPath ? `\nPath: ${relPath}` : ""}`
		await this.say("error", message, undefined, undefined, false, existingTs)
		return formatResponse.toolError(message)
	}

	private async applyLatestBrowserSettings(): Promise<BrowserSession> {
		await this.browser.dispose()
		this.browser = this.options.createBrowser()
		return this.browser
	}

	private async runUserPromptSubmitHook(content: ClineContent[], _context: "initial_task" | "resume" | "feedback") {
		const prompt = content
			.filter((item): item is Extract<ClineContent, { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join("\n")
		return executeHook({
			hookName: "UserPromptSubmit",
			hookInput: { userPromptSubmit: { prompt, attachments: [] } },
			isCancellable: true,
			say: (...args) => this.say(...args),
			setActiveHookExecution: this.callbacks.setActiveHookExecution,
			clearActiveHookExecution: this.callbacks.clearActiveHookExecution,
			messageStateHandler: this.options.messages,
			taskId: this.options.taskId,
			hooksEnabled: getHooksEnabledSafe(this.options.stateManager.getGlobalSettingsKey("hooksEnabled")),
			model: getHookModelContext(this.options.api.current(), this.options.stateManager),
		})
	}

	private requireCommandExecutor(): CommandExecutor {
		if (!this.commandExecutor) throw new Error("Task command executor is not bound")
		return this.commandExecutor
	}
}
