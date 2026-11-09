import type { ProviderTelemetryRole } from "@shared/provider-attempt-observer"
import { taskTraceSource } from "@/services/telemetry/service/task-trace-context"
import type { UsageToolCall } from "../../telemetry/UsageToolCalls"

/**
 * Settles one subagent turn's Usage logical request.
 *
 * The Provider stream reports usage and the tool calls it asked for, but the
 * Runner executes those tools afterwards. This owner carries the turn's request
 * identity so the settlement can reach back to the request that produced them:
 * a turn that ran tools closes with their real outcomes, and a turn that asked
 * for none releases the request at its Provider terminal.
 */
export class SubagentRoundUsageSettlement {
    private requestId: string | undefined
    private attempt = 0

    constructor(
        private readonly taskId: string,
        private readonly role: ProviderTelemetryRole,
    ) {}

    /** Start a turn's logical request; every turn sends once and runs its own tools. */
    begin(requestId: string): void {
        this.requestId = requestId
        this.attempt = 0
    }

    /** Record which retry of this request is in flight. */
    attemptChanged(attempt: number): void {
        this.attempt = attempt
    }

    /** The turn ran these tools; close its request with their real outcomes. */
    settleTools(toolCalls: readonly UsageToolCall[]): void {
        const logicalRequestId = this.requestId
        if (!logicalRequestId) return
        taskTraceSource(this.taskId)?.providerLogicalToolsSettled?.(
            { role: this.role, logicalRequestId, taskAttempt: this.attempt },
            toolCalls,
        )
    }

    /** The turn asked for no tool, so its deferred settlement ends now. */
    release(): void {
        const logicalRequestId = this.requestId
        if (!logicalRequestId) return
        taskTraceSource(this.taskId)?.providerLogicalToolsExpected?.({
            role: this.role,
            logicalRequestId,
            taskAttempt: this.attempt,
        })
    }
}
