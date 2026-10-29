import { SubagentRunObservation } from "../../observability/subagent-run-observation"

export type SubagentExecStatus = "completed" | "failed" | "timeout" | "cancelled"

export interface SubagentRuntimeConfig {
    profileName?: string
    providerId: string
    modelId: string
    apiFormat?: string
    thinkingEnabled?: boolean
    reasoningEffort?: string
    thinkingBudgetTokens?: number
}

export interface SubagentRunStats {
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
    totalCost: number
    currency: string
    contextTokens: number
    contextWindow: number
    contextUsagePercentage: number
}

export interface SubagentProgressEvent {
    kind: "thinking" | "assistant_message" | "tool_call" | "tool_result" | "retry"
    phase?: "delta" | "final"
    text?: string
    toolCallId?: string
    toolName?: string
    toolStatus?: "started" | "completed" | "failed"
    summary?: string
    durationMs?: number
    error?: string
    retryAttempt?: number
    maxRetries?: number
    delayMs?: number
    cumulativeDelayMs?: number
}

export interface SubagentProgressUpdate {
    runtime?: SubagentRuntimeConfig
    stats?: SubagentRunStats
    latestToolCall?: string
    status?: "running" | "completed" | "failed" | "cancelled"
    result?: string
    error?: string
    event?: SubagentProgressEvent
}

export interface SubagentExecResult {
    status: SubagentExecStatus
    result?: string
    error?: string
    retryable?: boolean
    stats: SubagentRunStats
}

/**
 * Why a subagent run must stop exploring and produce its final result.
 *
 * `context_pressure` is raised from inside the run when usage crosses the
 * convergence threshold; `timeout` and `user` are raised from outside.
 */
export type SubagentFinishReason = "timeout" | "user" | "context_pressure"

export interface SubagentRunnerLike {
    run(prompt: string, onProgress: (update: SubagentProgressUpdate) => void): Promise<SubagentExecResult>
    abort(): Promise<void>
    requestFinish(reason: SubagentFinishReason): Promise<boolean>
}

export interface RunSubagentInput {
    runner: SubagentRunnerLike
    prompt: string
    timeoutSeconds: number
    onProgress: (update: SubagentProgressUpdate) => void
}

/**
 * Run a subagent with timeout and abort handling.
 * @param input Runner, prompt, timeout, and progress callback.
 * @returns Completed, failed, timeout, or cancelled execution result.
 */
export async function runSubagent(input: RunSubagentInput): Promise<SubagentExecResult> {
    const observation = new SubagentRunObservation(input.timeoutSeconds)
    let timeoutHandle: NodeJS.Timeout | undefined
    if (input.timeoutSeconds > 0) {
        timeoutHandle = setTimeout(() => {
            void input.runner.requestFinish("timeout")
        }, input.timeoutSeconds * 1000)
    }
    try {
        return await observation.run(() => input.runner.run(input.prompt, input.onProgress))
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
    }
}
