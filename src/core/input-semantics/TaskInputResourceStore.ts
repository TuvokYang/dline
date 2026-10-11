import { getTaskTempEntryDirectory, getTaskTempSectionDirectory, TaskTempSection } from "@core/storage/task-temp"
import type { InputResourceOwner } from "@shared/input-semantics/document"
import { type InputResourceRoot, InputResourceStore } from "./InputResourceStore"

/**
 * The input resources one task owns.
 *
 * They live in the task's own temp storage, which ties their lifetime to the
 * task and already lies inside the task read scope, so the agent may open a
 * resource without a new permission. Earlier flat `input_*.txt` files in the
 * same section stay where they are; only legacy path consumers read them.
 */
export function taskInputResourceRoot(taskId: string): InputResourceRoot {
    // Resolving the section validates the task identity before any resource is addressed.
    getTaskTempSectionDirectory(taskId, TaskTempSection.InputResources)
    const owner: InputResourceOwner = { kind: "task", taskId }
    return {
        owner,
        resourceDirectory: (resourceId) => getTaskTempEntryDirectory(taskId, TaskTempSection.InputResources, resourceId),
    }
}

export function openTaskInputResources(taskId: string): InputResourceStore {
    return new InputResourceStore(taskInputResourceRoot(taskId))
}
