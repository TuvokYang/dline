import type { TaskActivityEvent } from "@shared/proto/dline/task"

export type SubagentToolStepStatus = "started" | "completed" | "failed"

export interface SubagentToolStep {
    toolCallId: string
    toolName: string
    status: SubagentToolStepStatus
    summary?: string
    resultText?: string
    error?: string
    durationMs?: number
    sequence: number
}

export interface SubagentRetryAttempt {
    retryAttempt: number
    maxRetries: number
    delayMs: number
    cumulativeDelayMs: number
    sequence: number
}

export interface SubagentActivityDetail {
    task?: string
    context?: string
}

export interface SubagentActivityPresentationModel {
    toolSteps: SubagentToolStep[]
    retryAttempts: SubagentRetryAttempt[]
    toolCount: number
}

/** Normalize user-facing multiline text without changing relative indentation. */
export function normalizeSubagentDisplayText(value: string): string {
    const lines = value.replace(/\r\n?/g, "\n").split("\n")

    while (lines.length > 0 && lines[0].trim() === "") lines.shift()
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop()

    const commonIndent = lines
        .filter((line) => line.trim().length > 0)
        .reduce<number | undefined>((minimum, line) => {
            const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0
            return minimum === undefined ? indentation : Math.min(minimum, indentation)
        }, undefined)

    const indent = commonIndent ?? 0
    return lines
        .map((line) => (line.trim().length === 0 ? "" : line.slice(indent).replace(/[ \t]+$/g, "")))
        .join("\n")
        .trim()
}

/** Remove a duplicated tool name from a raw execution summary. */
export function normalizeSubagentToolSummary(toolName: string, summary: string | undefined): string | undefined {
    const normalized = summary ? normalizeSubagentDisplayText(summary) : ""
    if (!normalized) return undefined
    if (normalized === toolName) return undefined
    if (normalized.startsWith(toolName)) {
        const remainder = normalized.slice(toolName.length).trimStart()
        if (remainder) return remainder
    }
    return normalized
}

function compareEvents(left: TaskActivityEvent, right: TaskActivityEvent): number {
    return left.sequence - right.sequence || left.timestamp - right.timestamp
}

function isToolStepStatus(value: string | undefined): value is SubagentToolStepStatus {
    return value === "started" || value === "completed" || value === "failed"
}

function createFallbackToolCallId(event: TaskActivityEvent): string {
    return `event-${event.sequence}`
}

function isNonNegativeFinite(value: number | undefined): value is number {
    return Number.isFinite(value) && (value as number) >= 0
}

function filterCurrentAttempt(events: TaskActivityEvent[], currentAttempt: number | undefined): TaskActivityEvent[] {
    return currentAttempt === undefined ? events : events.filter((event) => event.attempt === currentAttempt)
}

/** Parse the persisted Subagent prompt without exposing raw XML-like tags. */
export function parseSubagentActivityDetail(detail: string | undefined): SubagentActivityDetail {
    if (!detail?.trim()) return {}
    const extract = (tag: "task" | "context") => {
        const match = detail.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))
        const normalized = match ? normalizeSubagentDisplayText(match[1]) : ""
        return normalized || undefined
    }
    return { task: extract("task"), context: extract("context") }
}

/** Project structured provider retry events into display attempts. */
export function buildSubagentRetryAttempts(
    events: TaskActivityEvent[] | undefined,
    currentAttempt?: number,
): SubagentRetryAttempt[] {
    if (!events?.length) return []

    return filterCurrentAttempt([...events], currentAttempt)
        .sort(compareEvents)
        .filter(
            (event) =>
                event.kind === "retry" &&
                isNonNegativeFinite(event.retryAttempt) &&
                isNonNegativeFinite(event.maxRetries) &&
                isNonNegativeFinite(event.delayMs) &&
                isNonNegativeFinite(event.cumulativeDelayMs),
        )
        .map((event) => ({
            retryAttempt: event.retryAttempt as number,
            maxRetries: event.maxRetries as number,
            delayMs: event.delayMs as number,
            cumulativeDelayMs: event.cumulativeDelayMs as number,
            sequence: event.sequence,
        }))
}

/** Merge low-level activity events into one expandable row per tool call. */
export function buildSubagentToolSteps(events: TaskActivityEvent[] | undefined, currentAttempt?: number): SubagentToolStep[] {
    if (!events?.length) return []

    const steps = new Map<string, SubagentToolStep>()
    for (const event of filterCurrentAttempt([...events], currentAttempt).sort(compareEvents)) {
        if (event.kind !== "tool_call" && event.kind !== "tool_result") continue

        const toolCallId = event.toolCallId || createFallbackToolCallId(event)
        const existing = steps.get(toolCallId)
        const toolName = event.toolName || existing?.toolName || "tool"
        const next: SubagentToolStep = existing ?? {
            toolCallId,
            toolName,
            status: "started",
            sequence: event.sequence,
        }

        next.toolName = toolName
        next.sequence = Math.min(next.sequence, event.sequence)
        if (event.kind === "tool_call") {
            if (isToolStepStatus(event.toolStatus)) next.status = event.toolStatus
            const summary = normalizeSubagentToolSummary(toolName, event.summary)
            if (summary) next.summary = summary
            if (event.durationMs !== undefined) next.durationMs = event.durationMs
            if (event.error) {
                next.error = normalizeSubagentDisplayText(event.error)
                next.status = "failed"
            }
        } else {
            if (event.text) next.resultText = normalizeSubagentDisplayText(event.text)
            if (event.error) {
                next.error = normalizeSubagentDisplayText(event.error)
                next.status = "failed"
            } else if (next.status === "started") {
                next.status = "completed"
            }
        }
        steps.set(toolCallId, next)
    }

    return [...steps.values()].sort((left, right) => left.sequence - right.sequence)
}

/** Build the single attempt-aware model consumed by header metrics and timelines. */
export function buildSubagentActivityPresentation(
    events: TaskActivityEvent[] | undefined,
    currentAttempt?: number,
): SubagentActivityPresentationModel {
    const toolSteps = buildSubagentToolSteps(events, currentAttempt)
    return {
        toolSteps,
        retryAttempts: buildSubagentRetryAttempts(events, currentAttempt),
        toolCount: toolSteps.length,
    }
}
