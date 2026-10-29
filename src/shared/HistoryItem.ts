import type { ContextWindowIndicatorSnapshot } from "./context-window-indicator"
import type { Mode } from "./storage/types"

/**
 * Characters of `HistoryItem.task` text retained per entry.
 *
 * `task` is a list label, not the task itself: the panel title, the history
 * row, and search all use it as short text, while the authoritative task text
 * lives in the task's own `ui_messages.jsonl`. Keeping it verbatim let the
 * single global `taskHistory` key grow without bound, which is what made state
 * pushes reach megabytes in long-running workspaces.
 */
export const MAX_HISTORY_TASK_TEXT_LENGTH = 512

/** Shorten one task text to the history label length. */
export function summarizeHistoryTaskText(taskText: string): string {
    return taskText.length <= MAX_HISTORY_TASK_TEXT_LENGTH ? taskText : taskText.slice(0, MAX_HISTORY_TASK_TEXT_LENGTH)
}

export type HistoryItem = {
    id: string
    ulid?: string // ULID for better tracking and metrics
    /** Timestamp of the latest persisted task edit/activity, in milliseconds. */
    ts: number
    /** Short label for lists and titles, bounded by MAX_HISTORY_TASK_TEXT_LENGTH. */
    task: string
    tokensIn: number
    tokensOut: number
    cacheWrites?: number
    cacheReads?: number
    totalCost: number
    cacheHitRate?: number // Cache hit rate percentage (0-100)
    currency?: string // Billing currency code

    size?: number
    shadowGitConfigWorkTree?: string
    cwdOnTaskInitialization?: string
    conversationHistoryDeletedRange?: [number, number]
    isFavorited?: boolean
    /** Materialized projection of the canonical Task completion state. */
    isCompleted?: boolean
    /** Runtime revision that produced the completion projection. */
    completionStateRevision?: number
    checkpointManagerErrorMessage?: string

    modelId?: string
    /** The API provider used for this task (e.g., "anthropic", "openrouter"). */
    providerId?: string
    /** The mode this task was last running in ("plan" | "act"). */
    mode?: Mode
    /** IDs of tasks spawned from this task (parent → child). */
    spawnedTaskIds?: string[]
    /** The parent task ID if this task was spawned from another. */
    parentTaskId?: string
    /**
     * Last context-window occupancy the task showed, kept so a reopened task can
     * draw its header before it sends anything. Only the task's own panel reads
     * it; the pushed history list leaves it out.
     */
    contextWindowIndicator?: ContextWindowIndicatorSnapshot
}
