import type { StateManager } from "@core/storage/StateManager"
import type { MessageStateHandler } from "@core/task/message-state"
import { Logger } from "@/shared/services/Logger"
import { HookDiscoveryCache } from "./HookDiscoveryCache"
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
    /**
     * Test/host seam for TaskStart discovery. Resolves `undefined` when discovery
     * did not settle within `waitMs`; the scan itself keeps running.
     */
    readonly discoverHooks?: (waitMs: number) => Promise<readonly string[] | undefined>
}

/**
 * How long a task start may join a discovery scan that is already in flight.
 *
 * The cache re-warms TaskStart after every hook change, so an empty snapshot
 * means a scan is running. Joining it briefly keeps a hook edited just before a
 * task from being skipped, while a cold filesystem probe still cannot hold the
 * first provider request for longer than this bound.
 */
const TASK_START_DISCOVERY_WAIT_MS = 1_500

/**
 * Run the configured TaskStart hook and return its context modification.
 *
 * A hook that cancels the start is honoured by throwing, because continuing
 * would run a task the workspace policy just refused.
 */
export class HookTaskStartContext implements TaskStartContextPort {
    constructor(private readonly options: HookTaskStartContextOptions) {}

    async collect(identity: TaskStartHookIdentity): Promise<string | undefined> {
        const discover =
            this.options.discoverHooks ?? ((waitMs: number) => HookDiscoveryCache.getInstance().getWithin("TaskStart", waitMs))
        const discovered = await discover(TASK_START_DISCOVERY_WAIT_MS)
        if (discovered === undefined) {
            Logger.warn(
                `[TaskStart Hook] Discovery did not settle within ${TASK_START_DISCOVERY_WAIT_MS}ms for task ${identity.taskId}; continuing without a hook`,
            )
            return undefined
        }
        if (discovered.length === 0) return undefined

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
