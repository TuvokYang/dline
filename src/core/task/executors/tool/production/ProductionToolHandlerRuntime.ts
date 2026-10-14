import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool, getToolUseNames } from "@shared/tools"
import type { ToolHandlerResult } from "../../../tools/ToolExecutionResult"
import { describeToolDenial, presentToolDenial, ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import { ToolValidator } from "../../../tools/ToolValidator"
import type { TaskConfig } from "../../../tools/types/TaskConfig"

/**
 * Shared task-scoped handler registry used by provider planning and tool execution.
 *
 * Planning reads the registry through `planProductionTool`, the single owner of
 * how a call's admission becomes its approval.
 */
export class ProductionToolHandlerRuntime {
    readonly coordinator = new ToolExecutorCoordinator()

    constructor(validator: ToolValidator) {
        for (const toolName of getToolUseNames()) this.coordinator.registerByName(toolName as DlineDefaultTool, validator)
    }

    execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        return this.coordinator.execute(config, block)
    }

    presentDenial(config: TaskConfig, block: ToolUse): Promise<void> {
        return presentToolDenial(this.coordinator.getHandler(block.name), config, block)
    }

    /** The result a refused call reports to the model, in its handler's own words. */
    describeDenial(config: TaskConfig, block: ToolUse): Promise<string> {
        return describeToolDenial(this.coordinator.getHandler(block.name), config, block)
    }

    restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
        return this.coordinator.restoreSubagentRetry(config, activityId)
    }
}
