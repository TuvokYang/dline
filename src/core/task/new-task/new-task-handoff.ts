import { type ClineUserContent, imageSourceToUrl } from "@shared/messages/content"
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

/** User feedback carried into the successor Task's initial Provider input. */
export interface NewTaskFeedback {
    readonly text: string
    readonly images: readonly string[]
    readonly files: readonly string[]
}

/** Complete one-shot data required by the current Controller to start the successor Task. */
export interface NewTaskHandoff {
    readonly context: string
    readonly source: NewTaskConsumedState
    readonly initialUserContent: readonly ClineUserContent[]
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

/** A handoff's initial content in the shape a task submission carries it. */
export interface SuccessorSubmission {
    /** Text that follows the task in the first request, as submission context. */
    readonly context: readonly string[]
    /** Images as data URLs, submitted with the task. */
    readonly images: readonly string[]
}

/**
 * Split a handoff's initial content into submission context and images.
 *
 * The successor's first input is an ordinary submission whose text is the
 * handed-over context, so the feedback the user gave has to travel beside it
 * rather than replace it.
 */
export function successorSubmission(initialUserContent: readonly ClineUserContent[]): SuccessorSubmission {
    const context: string[] = []
    const images: string[] = []
    for (const block of initialUserContent) {
        if (block.type === "text") context.push(block.text)
        else if (block.type === "image") images.push(imageSourceToUrl(block.source))
    }
    return { context, images }
}

/** Snapshot a successor directive, prepared feedback content, and current Task-local settings. */
export function createNewTaskHandoff(
    directive: StartSuccessorTaskPostCommitDirective,
    source: NewTaskSettingsSource,
    initialUserContent: readonly ClineUserContent[],
): NewTaskHandoff {
    return {
        context: directive.context,
        source: {
            functionId: directive.functionId,
            dlineTid: directive.dlineTid,
        },
        initialUserContent: [...initialUserContent],
        taskSettings: {
            mode: source.mode,
            ...(source.planModeProfileId === undefined ? {} : { planModeProfileId: source.planModeProfileId }),
            ...(source.planModeProfile === undefined ? {} : { planModeProfile: source.planModeProfile }),
            ...(source.actModeProfileId === undefined ? {} : { actModeProfileId: source.actModeProfileId }),
            ...(source.actModeProfile === undefined ? {} : { actModeProfile: source.actModeProfile }),
        },
    }
}
