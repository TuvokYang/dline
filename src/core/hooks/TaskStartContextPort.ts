import type { StateManager } from "@core/storage/StateManager"
import type { MessageStateHandler } from "@core/task/message-state"
import { Logger } from "@/shared/services/Logger"
import { executeHook } from "./hook-executor"
import type { HookModelInputContext } from "./hook-factory"
import { getHooksEnabledSafe } from "./hooks-utils"

/** The task identity a TaskStart hook is told about. */
export interface TaskStartHookIdentity {
	readonly taskId: string
	readonly ulid: string
	readonly initialTask: string
}

/**
 * Collect the workspace context a TaskStart hook contributes to the first turn.
 *
 * Returning the text instead of writing it keeps the hook out of the task
 * runtime: the caller folds it into the same admitted input every other
 * submission goes through, and a headless task that has no hook surface simply
 * has no port.
 */
export interface TaskStartContextPort {
	collect(identity: TaskStartHookIdentity): Promise<string | undefined>
}

export interface HookTaskStartContextOptions {
	readonly stateManager: StateManager
	readonly messages: MessageStateHandler
	readonly say: (type: string, text?: string) => Promise<number | undefined>
	readonly model?: () => HookModelInputContext | undefined
}

/**
 * Run the configured TaskStart hook and return its context modification.
 *
 * A hook that cancels the start is honoured by throwing, because continuing
 * would run a task the workspace policy just refused.
 */
export class HookTaskStartContext implements TaskStartContextPort {
	constructor(private readonly options: HookTaskStartContextOptions) {}

	async collect(identity: TaskStartHookIdentity): Promise<string | undefined> {
		const result = await executeHook({
			hookName: "TaskStart",
			hookInput: {
				taskStart: {
					taskMetadata: { taskId: identity.taskId, ulid: identity.ulid, initialTask: identity.initialTask },
				},
			},
			isCancellable: false,
			say: (type, text) => this.options.say(type as string, text),
			messageStateHandler: this.options.messages,
			taskId: identity.taskId,
			hooksEnabled: getHooksEnabledSafe(this.options.stateManager.getGlobalSettingsKey("hooksEnabled")),
			model: this.options.model?.(),
		})

		if (result.cancel) {
			throw new Error(result.errorMessage ?? "TaskStart hook cancelled the task")
		}
		if (result.errorMessage) {
			Logger.warn(`[TaskStart] Hook reported an error for task ${identity.taskId}: ${result.errorMessage}`)
		}
		return result.contextModification
	}
}
