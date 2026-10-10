import { getContextWindowIndicatorTotalTokens } from "@shared/context-window-indicator"
import { readContextTokens } from "../../../context/context-management/context-pressure"
import { getContextWindowInfo } from "../../../context/context-management/context-window-utils"
import type { TaskConfig } from "../types/TaskConfig"

export const DEFAULT_SUBAGENT_OUTPUT_TOKEN_RATIO = 0.05
const TOKEN_ESTIMATE_BYTES = 4

/**
 * Lower bound for the subagent final-response budget.
 *
 * The budget is derived from the main task's remaining context window, so a
 * nearly full main task drives it to zero and silently erases a subagent result
 * that may represent many minutes of work. A truncated result is always more
 * useful to the main task than an empty one, so the budget never drops below
 * this floor even when the remaining window is exhausted.
 */
export const MIN_SUBAGENT_OUTPUT_TOKENS = 512

export type SubagentOutputBudgetSource = "default_ratio" | "configured_ratio" | "configured_absolute"

export interface SubagentOutputBudget {
    /** Context-window capacity of the main task at subagent admission time. */
    mainTaskContextWindow: number
    /** Conservatively estimated context occupancy of the main task. */
    mainTaskContextTokens: number
    /** Remaining context-window capacity available to the main task. */
    mainTaskRemainingTokens: number
    /** Configured ratio or absolute token value before remaining-window capping. */
    requestedOutputTokens: number
    /** Effective hard budget passed to the subagent. */
    outputTokens: number
    source: SubagentOutputBudgetSource
}

/** Return whether a YAML maxOutputTokens value has the supported ratio/absolute form. */
export function isValidSubagentOutputTokenValue(value: number): boolean {
    return Number.isFinite(value) && value > 0 && (value < 1 || Number.isInteger(value))
}

/** Estimate text tokens using the repository-wide conservative UTF-8 four-byte heuristic. */
export function estimateSubagentOutputTokens(text: string): number {
    if (!text) return 0
    return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / TOKEN_ESTIMATE_BYTES))
}

/** Resolve the main task's remaining context window for one subagent admission. */
export function getMainTaskRemainingTokens(config: Pick<TaskConfig, "api" | "messageState" | "taskState">): {
    contextWindow: number
    contextTokens: number
    remainingTokens: number
} {
    const contextWindow = Math.max(0, Math.floor(getContextWindowInfo(config.api).contextWindow))
    const indicatorTokens = config.taskState.contextWindowIndicator
        ? getContextWindowIndicatorTotalTokens(config.taskState.contextWindowIndicator)
        : 0
    const persistedTokens = getLatestPersistedContextTokens(config.messageState.clineMessages)
    const contextTokens = Math.min(contextWindow, Math.max(indicatorTokens, persistedTokens))
    return {
        contextWindow,
        contextTokens,
        remainingTokens: Math.max(0, contextWindow - contextTokens),
    }
}

/** Resolve a ratio/absolute YAML value against the main task's remaining context window. */
export function resolveSubagentOutputBudget(
    config: Pick<TaskConfig, "api" | "messageState" | "taskState">,
    configuredMaxOutputTokens?: number,
): SubagentOutputBudget {
    const mainTask = getMainTaskRemainingTokens(config)
    const hasValidConfiguration =
        configuredMaxOutputTokens !== undefined && isValidSubagentOutputTokenValue(configuredMaxOutputTokens)
    const configured = hasValidConfiguration ? configuredMaxOutputTokens : DEFAULT_SUBAGENT_OUTPUT_TOKEN_RATIO
    const source: SubagentOutputBudgetSource = !hasValidConfiguration
        ? "default_ratio"
        : configuredMaxOutputTokens < 1
          ? "configured_ratio"
          : "configured_absolute"
    const requestedOutputTokens =
        configured < 1
            ? mainTask.remainingTokens > 0
                ? Math.max(1, Math.ceil(mainTask.remainingTokens * configured))
                : 0
            : Math.floor(configured)
    const cappedOutputTokens = Math.min(mainTask.remainingTokens, Math.max(0, requestedOutputTokens))
    return {
        mainTaskContextWindow: mainTask.contextWindow,
        mainTaskContextTokens: mainTask.contextTokens,
        mainTaskRemainingTokens: mainTask.remainingTokens,
        requestedOutputTokens,
        outputTokens: Math.max(MIN_SUBAGENT_OUTPUT_TOKENS, cappedOutputTokens),
        source,
    }
}

/** Add the effective final-response budget to the subagent's user task prompt. */
export function buildSubagentOutputBudgetPrompt(prompt: string, outputTokens: number): string {
    const budgetSection = [
        "# Final Response Budget",
        "Your final attempt_completion result is returned to the main task.",
        "Keep that final result within " + outputTokens.toLocaleString() + " tokens.",
        "This is a hard output budget; prioritize the most useful findings and omit lower-value detail.",
    ].join("\n")
    return prompt.trimEnd() + "\n\n" + budgetSection
}

/**
 * Truncate text without exceeding the requested estimated token budget.
 *
 * Truncation stays visible to the main task: a silently shortened result cannot
 * be distinguished from a complete one, so the caller would keep reasoning on
 * partial findings without knowing anything was dropped.
 */
export function truncateTextToSubagentOutputBudget(text: string, maxTokens: number): string {
    if (!text || maxTokens <= 0) return ""
    if (estimateSubagentOutputTokens(text) <= maxTokens) return text

    const marker = "\n...[truncated to " + maxTokens.toLocaleString() + " tokens; findings exceeded the output budget]"
    const markerTokens = estimateSubagentOutputTokens(marker)
    if (markerTokens >= maxTokens) return sliceTextToTokenBudget(text, maxTokens)

    const body = sliceTextToTokenBudget(text, maxTokens - markerTokens)
    const withMarker = body + marker
    return estimateSubagentOutputTokens(withMarker) <= maxTokens ? withMarker : sliceTextToTokenBudget(text, maxTokens)
}

function getLatestPersistedContextTokens(messages: TaskConfig["messageState"]["clineMessages"] | undefined): number {
    if (!messages) return 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.type !== "say" || message.say !== "api_req_started") continue
        const contextTokens = readContextTokens(message.text)
        if (contextTokens > 0) return contextTokens
    }
    return 0
}

function sliceTextToTokenBudget(text: string, maxTokens: number): string {
    const codePoints = Array.from(text)
    let low = 0
    let high = codePoints.length
    let best = ""
    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = codePoints.slice(0, middle).join("")
        if (estimateSubagentOutputTokens(candidate) <= maxTokens) {
            best = candidate
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    return best
}
