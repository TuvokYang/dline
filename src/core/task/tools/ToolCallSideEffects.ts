import type { ToolUse } from "@core/assistant-message"
import { Logger } from "@/shared/services/Logger"
import { type ChecklistChange, type ChecklistReport, diffChecklist, parseChecklist } from "../telemetry/ChecklistDiff"
import type { TaskConfig } from "./types/TaskConfig"

/**
 * Effects that accompany a tool call without belonging to any tool.
 *
 * `task_progress` rides on every tool rather than being one. It has no owning
 * handler, so it is applied once around the call instead of being repeated in
 * every handler.
 *
 * Every member is optional because these are capabilities of the surface a task
 * runs on, not of tool execution. A task driven by a person has a checklist to
 * update and a workspace to restore; a task instantiated to generate a title,
 * review a change, or decide an approval has neither, and must be able to run
 * the same tools without supplying stubs for effects it does not have.
 */
export interface ToolCallSideEffectPort {
    /** Publish the checklist a call carried, for a surface that presents one. */
    readonly reportProgress?: (progress: string) => Promise<void>
    /**
     * Report what changed in the checklist, for the usage fact of the turn.
     *
     * The change is computed here because this is the only place that sees both
     * reports. A surface without a checklist never supplies the callback, so an
     * absent callback means "this task has no checklist", not "nothing changed".
     */
    readonly observeChecklist?: (changes: readonly ChecklistChange[]) => void
}

/**
 * Read the effects the given task surface actually supports.
 *
 * A capability the surface does not provide stays undefined rather than
 * becoming a no-op function, so "this task has no checklist" is visible to the
 * caller instead of being indistinguishable from "the checklist was empty".
 */
export function resolveToolCallSideEffects(config: TaskConfig): ToolCallSideEffectPort {
    const callbacks = config.callbacks as Partial<TaskConfig["callbacks"]> | undefined
    return {
        ...(callbacks?.updateFCListFromToolResponse === undefined
            ? {}
            : { reportProgress: (progress: string) => callbacks.updateFCListFromToolResponse!(progress) }),
        ...(callbacks?.observeChecklist === undefined
            ? {}
            : { observeChecklist: (changes: readonly ChecklistChange[]) => callbacks.observeChecklist!(changes) }),
    }
}

/**
 * Apply the checklist a call carried, after the call.
 *
 * It runs after the handler because chat rows are ordered by a presentation
 * id: the tool's own row was numbered when the call was planned, while a row
 * appended here takes a fresh, higher id. Reporting first would emit an id
 * below the row that follows it, and the list would render no further.
 *
 * Failures are contained: the checklist is bookkeeping beside the call, not a
 * precondition for it.
 */
export async function applyToolCallSideEffects(port: ToolCallSideEffectPort, block: ToolUse): Promise<void> {
    const progress = block.params.task_progress
    if (!progress?.trim()) return
    observeChecklist(port, progress)
    if (port.reportProgress) {
        try {
            await port.reportProgress(progress)
        } catch (error) {
            Logger.error(`Failed to apply task_progress from ${block.name}`, error instanceof Error ? error : undefined)
        }
    }
}

/** The last checklist this task saw, so the next report can be compared against it. */
const lastChecklist = new WeakMap<ToolCallSideEffectPort, ChecklistReport>()

/** Bookkeeping beside the call: a checklist usage cannot read is not a failed call. */
function observeChecklist(port: ToolCallSideEffectPort, markdown: string): void {
    if (!port.observeChecklist) return
    try {
        const previous = lastChecklist.get(port)
        const report = parseChecklist(markdown)
        const changes = diffChecklist(previous, report)
        lastChecklist.set(port, report)
        if (changes.length > 0) port.observeChecklist(changes)
    } catch (error) {
        Logger.error("Failed to observe task_progress checklist", error instanceof Error ? error : undefined)
    }
}
