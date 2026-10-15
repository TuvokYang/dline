import type { ToolUse } from "@core/assistant-message"
import type { CheckpointSource } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { DlineDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "./types/TaskConfig"

/**
 * Effects that accompany a tool call without belonging to any tool.
 *
 * `task_progress` rides on every tool rather than being one, and a named file
 * edit owes the restore point taken just before it. Neither has an owning
 * handler, so both are applied once around the call instead of being repeated
 * in each of them.
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
     * Add a file restore point before a named file edit, for a surface that
     * tracks workspace history. Never rejects.
     */
    readonly ensurePreEditCheckpoint?: (
        source?: Extract<CheckpointSource, { kind: "pre_edit" }>,
        signal?: AbortSignal,
    ) => Promise<void>
}

/** Tools whose whole effect is a change to files they name. */
const NAMED_FILE_EDIT_TOOLS: ReadonlySet<DlineDefaultTool> = new Set([
    DlineDefaultTool.FILE_NEW,
    DlineDefaultTool.FILE_EDIT,
    DlineDefaultTool.APPLY_PATCH,
    DlineDefaultTool.REPLACE_TEXT,
    DlineDefaultTool.RENAME,
    DlineDefaultTool.NEW_RULE,
])

/**
 * Whether a tool earns a restore point of its own before it runs.
 *
 * A file edit is a step a user may want to undo by itself. Every other change
 * to the workspace is covered by the checkpoint added before the next request,
 * whatever made it.
 */
export function toolEditsNamedFiles(tool: DlineDefaultTool): boolean {
    return NAMED_FILE_EDIT_TOOLS.has(tool)
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
        ...(callbacks?.ensurePreEditCheckpoint === undefined
            ? {}
            : {
                  ensurePreEditCheckpoint: (source?: Extract<CheckpointSource, { kind: "pre_edit" }>, signal?: AbortSignal) =>
                      callbacks.ensurePreEditCheckpoint!(source, signal),
              }),
    }
}

/**
 * Before an approved named file edit runs: commit the files it is about to
 * change when they moved since the latest checkpoint.
 *
 * Awaited so the restore point holds the files as they were before this edit.
 * A checkpoint is a side feature of the task, so a failure is contained and
 * the edit runs.
 *
 * @param signal - The operation that owns the call. The wait for the restore
 *   point gives up when it aborts.
 * @returns false when `signal` aborted while the restore point was pending: the
 *   operation that owned the edit was stopped, so the caller must not start it
 */
export async function ensureToolCallCheckpoint(
    port: ToolCallSideEffectPort,
    block: ToolUse,
    signal?: AbortSignal,
    association: "tool" | "standalone" = "tool",
): Promise<boolean> {
    if (!port.ensurePreEditCheckpoint || !toolEditsNamedFiles(block.name)) return true
    try {
        const source =
            association === "tool"
                ? {
                      kind: "pre_edit" as const,
                      toolTs: block.ts,
                      toolName: block.name,
                      ...(block.dline_tid ? { dlineTid: block.dline_tid } : {}),
                  }
                : undefined
        await port.ensurePreEditCheckpoint(source, signal)
    } catch (error) {
        Logger.error(`Pre-edit checkpoint failed before ${block.name}`, error instanceof Error ? error : undefined)
    }
    return !signal?.aborted
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
    if (port.reportProgress && progress?.trim()) {
        try {
            await port.reportProgress(progress)
        } catch (error) {
            Logger.error(`Failed to apply task_progress from ${block.name}`, error instanceof Error ? error : undefined)
        }
    }
}
