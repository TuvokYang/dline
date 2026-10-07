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
import type { PresentationIdSequence } from "@core/task/session/PresentationIdSequence"
import type { TaskApiHandlerOwner } from "@core/task/session/TaskApiHandlerOwner"
import type { TaskInteractionOwner } from "@core/task/session/TaskInteractionOwner"
import type { DefaultToolHandlerState } from "@core/task/tools/state/ToolHandlerState"
import type { TaskCallbacks } from "@core/task/tools/types/TaskConfig"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import { BrowserSession } from "@services/browser/BrowserSession"
import type { UiAsk, UiMessage, UiSay } from "@shared/ExtensionMessage"
import type { ClineContent } from "@shared/messages/content"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Logger } from "@shared/services/Logger"
import type { ClineDefaultTool } from "@shared/tools"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import { sendPartialMessageEvent } from "../../ui/subscribeToPartialMessage"

export interface ControllerTaskCallbacksOwnerOptions {
	readonly controller: Controller
	readonly taskId: string
	readonly stateManager: StateManager
	readonly messages: MessageStateHandler
	readonly interactions: TaskInteractionOwner
	/** The session's chat-row id sequence; every new row a tool shows draws its id from it. */
	readonly nextPresentationId: PresentationIdSequence
	readonly api: TaskApiHandlerOwner
	readonly toolState: DefaultToolHandlerState
	readonly createBrowser: () => BrowserSession
}

function interactionKind(type: UiAsk | string): InteractionKind {
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
			awaitInitialCheckpoint: () => this.checkpointManager?.awaitInitialCheckpoint?.() ?? Promise.resolve(),
			sayAndCreateMissingParamError: (tool, param, relPath, ts) => this.missingParameter(tool, param, relPath, ts),
			executeCommandTool: (command, timeout, executionOptions) =>
				this.requireCommandExecutor().execute(command, timeout, executionOptions),
			killCommandTool: (functionId) => this.requireCommandExecutor().cancelCommandByFunctionId(functionId),
			cancelRunningCommandTool: () => this.requireCommandExecutor().cancelBackgroundCommand(),
			doesLatestTaskCompletionHaveNewChanges: () =>
				this.checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
			updateFCListFromToolResponse: async (progress) => {
				await this.focusChain.updateFCListFromToolResponse(progress)
				// The tab title carries checklist progress, as on dev.
				void options.controller.syncPanelTitle()
			},
			postStateToWebview: () => options.controller.postStateToWebview(),
			reinitExistingTaskFromId: (taskId) => options.controller.reinitExistingTaskFromId(taskId),
			cancelTask: () => this.requestCancellation(),
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
			updateClineMessage: (index, updates) => this.updateClineMessage(index, updates),
		}
	}

	/**
	 * Cancel the task on behalf of work that runs inside it.
	 *
	 * Every caller of this callback (a PreToolUse hook, a PreCompact hook) runs
	 * inside a halt participant, and the halt drains that participant's in-flight
	 * work before the cancel settles. Awaiting the settled cancel would make the
	 * caller wait for itself until the halt deadline expires. The runtime event
	 * loop admits the cancel synchronously when it is requested, so every event the
	 * caller produces after this returns is reduced behind the halt.
	 */
	private requestCancellation(): Promise<void> {
		void this.options.controller.cancelTask().catch((error: unknown) => {
			Logger.error(`[Task ${this.options.taskId}] In-task cancellation failed:`, error)
		})
		return Promise.resolve()
	}

	/**
	 * Patch a row a tool already showed, and show the patch.
	 *
	 * Persisting is not publishing: a follow-up answer marks its option as picked
	 * on a row that is already on screen, and a patch that only reached storage
	 * left the option unpressed until an unrelated reload. Delivery is not awaited
	 * as a failure, because the change is already durable.
	 */
	private async updateClineMessage(index: number, updates: Partial<UiMessage>): Promise<void> {
		await this.options.messages.updateClineMessage(index, updates)
		const row = this.options.messages.clineMessages[index]
		if (!row) return
		await this.publishRow(row, `patched row ${index}`)
	}

	/** Deliver one in-memory row to the active surface without making delivery its durability boundary. */
	private async publishRow(row: UiMessage, description: string): Promise<void> {
		await sendPartialMessageEvent(this.options.controller, convertClineMessageToProto(row)).catch((error: unknown) => {
			Logger.warn(
				`[Task ${this.options.taskId}] Could not publish ${description}: ${error instanceof Error ? error.message : String(error)}`,
			)
		})
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
		// A checklist loaded from disk changes the title's progress suffix.
		void this.options.controller.syncPanelTitle()
	}

	async dispose(): Promise<void> {
		this.focusChain.dispose()
		await this.browser.dispose()
	}

	private async say(
		type: UiSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		existingTs?: number,
		commandTs?: number,
	): Promise<number> {
		// A new row takes the next id of the session's sequence. A wall-clock id
		// can equal the id another owner just gave its row in the same
		// millisecond, and would then be taken for that row and overwrite it.
		const ts = existingTs ?? this.options.nextPresentationId()
		// commandTs is how a command_output row finds the command it belongs to;
		// dropping it here leaves the output orphaned and never rendered.
		const message: UiMessage = { ts, type: "say", say: type, text, images, files, partial, commandTs }
		// The command executor moves a row from pending to running by finding it
		// pending, and the row only offers Cancel while it is pending or running.
		if (type === "command" && !partial) message.commandStatus = this.commandStatusAt(ts)
		if (partial) {
			await this.options.messages.upsertClineMessageInMemory(message)
			await this.publishRow(message, `partial ${type} row ${ts}`)
		} else if (
			existingTs !== undefined &&
			this.options.messages.clineMessages.some((candidate) => candidate.ts === existingTs)
		) {
			await this.options.messages.finalizeClineMessage(message)
			await this.publishRow(message, `finalized ${type} row ${ts}`)
		} else await this.options.messages.addToClineMessages(message)
		return ts
	}

	/** A command row keeps the status its execution already reached; a new one waits to run. */
	private commandStatusAt(ts: number): UiMessage["commandStatus"] {
		return this.options.messages.clineMessages.find((candidate) => candidate.ts === ts)?.commandStatus ?? "pending"
	}

	private async ask(
		type: UiAsk,
		text?: string,
		_partial?: boolean,
		options?: { existingTs?: number; onTsCreated?: (ts: number) => void },
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[]; files?: string[] }> {
		const ts = options?.existingTs ?? this.options.nextPresentationId()
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
