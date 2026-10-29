import type { Mode } from "@shared/storage/types"
import type { StartSuccessorTaskPostCommitDirective } from "../tools/ToolExecutionResult"

/** Task-local bindings intentionally inherited by an independent New Task successor. */
export interface NewTaskInheritedSettings {
    readonly mode: Mode
    readonly planModeProfileId?: string
    readonly planModeProfile?: string
    readonly actModeProfileId?: string
    readonly actModeProfile?: string
}

/** Canonical identity of the New Task declaration consumed by the old Task. */
export interface NewTaskConsumedState {
    readonly functionId: string
    readonly dlineTid: string
}

/**
 * Complete one-shot data required by the current Controller to start the successor Task.
 *
 * The successor opens exactly like a spawned task: the task and context the
 * model wrote, plus the inherited settings. Feedback the user gave by declining
 * a handoff belongs to the conversation it was given in, so it never travels to
 * the successor.
 */
export interface NewTaskHandoff {
    readonly task: string
    readonly context: string
    readonly source: NewTaskConsumedState
    readonly taskSettings: NewTaskInheritedSettings
}

/** Read-only source for capturing task-local bindings without global active-task routing. */
export interface NewTaskSettingsSource {
    readonly mode: Mode
    readonly planModeProfileId?: string
    readonly planModeProfile?: string
    readonly actModeProfileId?: string
    readonly actModeProfile?: string
}

/** Snapshot a successor directive and the current Task-local settings. */
export function createNewTaskHandoff(
    directive: StartSuccessorTaskPostCommitDirective,
    source: NewTaskSettingsSource,
): NewTaskHandoff {
    return {
        task: directive.task,
        context: directive.context,
        source: {
            functionId: directive.functionId,
            dlineTid: directive.dlineTid,
        },
        taskSettings: {
            mode: source.mode,
            ...(source.planModeProfileId === undefined ? {} : { planModeProfileId: source.planModeProfileId }),
            ...(source.planModeProfile === undefined ? {} : { planModeProfile: source.planModeProfile }),
            ...(source.actModeProfileId === undefined ? {} : { actModeProfileId: source.actModeProfileId }),
            ...(source.actModeProfile === undefined ? {} : { actModeProfile: source.actModeProfile }),
        },
    }
}
