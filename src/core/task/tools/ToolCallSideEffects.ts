import type { ToolUse } from "@core/assistant-message"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES, READ_ONLY_TOOLS } from "@/shared/tools"
import type { TaskConfig } from "./types/TaskConfig"

/**
 * Effects that accompany a tool call without belonging to any tool.
 *
 * `task_progress` rides on every tool rather than being one, and a restore
 * point is owed by whatever changed the workspace. Neither has an owning
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
    /** Commit a restore point, for a surface that tracks workspace history. */
    readonly commitCheckpoint?: () => Promise<void>
    /**
     * Wait until the task's baseline restore point exists, for a surface that
     * builds one while the first request is in flight.
     */
    readonly awaitInitialCheckpoint?: () => Promise<void>
}

/**
 * Whether a tool warrants a restore point.
 *
 * Read-only tools leave nothing to restore. Conversational tools end the turn
 * and `attempt_completion` commits its own checkpoint against the completion
 * row it publishes, so committing again here would attach a second one to the
 * same state.
 */
export function toolMayChangeWorkspace(tool: ClineDefaultTool): boolean {
    if ((READ_ONLY_TOOLS as readonly ClineDefaultTool[]).includes(tool)) return false
    // MCP calls may mutate external systems, but a Dline workspace checkpoint
    // cannot restore those side effects. Emitting one after every response only
    // creates misleading restore rows and duplicates the call/result presentation.
    if (tool === ClineDefaultTool.MCP_USE || tool === ClineDefaultTool.MCP_ACCESS) return false
    return !CONVERSATIONAL_TOOL_NAMES.has(tool)
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
        ...(callbacks?.saveCheckpoint === undefined ? {} : { commitCheckpoint: () => callbacks.saveCheckpoint!() }),
        ...(callbacks?.awaitInitialCheckpoint === undefined
            ? {}
            : { awaitInitialCheckpoint: () => callbacks.awaitInitialCheckpoint!() }),
    }
}

/**
 * Hold a tool that may touch the workspace until the baseline restore point exists.
 *
 * The baseline is built in parallel with the first provider request, so a
 * read-only tool may overlap it, but anything else could change files the
 * baseline has not captured yet and leave no state to restore to. That
 * includes `attempt_completion`, whose own checkpoint would otherwise build the
 * baseline between showing the result and offering the next step.
 */
export async function awaitToolCallPreconditions(port: ToolCallSideEffectPort, tool: ClineDefaultTool): Promise<void> {
    if (!port.awaitInitialCheckpoint || (READ_ONLY_TOOLS as readonly ClineDefaultTool[]).includes(tool)) return
    try {
        await port.awaitInitialCheckpoint()
    } catch (error) {
        Logger.error(`Initial checkpoint failed before ${tool}`, error instanceof Error ? error : undefined)
    }
}

/**
 * Apply both effects after one tool call.
 *
 * They run after the handler because chat rows are ordered by a presentation
 * id: the tool's own row was numbered when the call was planned, while a row
 * appended here takes a fresh, higher id. Reporting first would emit an id
 * below the row that follows it, and the list would render no further. A
 * restore point likewise has to capture what the call produced rather than the
 * state preceding it.
 *
 * Failures are contained. These are bookkeeping beside the call, not
 * preconditions for it, so an unwritable checklist or an unavailable shadow
 * repository must not turn into a refused tool.
 */
export async function applyToolCallSideEffects(
    port: ToolCallSideEffectPort,
    block: ToolUse,
    tool: ClineDefaultTool,
): Promise<void> {
    const progress = block.params.task_progress
    if (port.reportProgress && progress?.trim()) {
        try {
            await port.reportProgress(progress)
        } catch (error) {
            Logger.error(`Failed to apply task_progress from ${block.name}`, error instanceof Error ? error : undefined)
        }
    }

    if (port.commitCheckpoint && toolMayChangeWorkspace(tool)) {
        try {
            await port.commitCheckpoint()
        } catch (error) {
            Logger.error(`Failed to save checkpoint after ${tool}`, error instanceof Error ? error : undefined)
        }
    }
}
