import { isCompletedFocusChainItem, isFocusChainItem } from "@shared/focus-chain-utils"

const CHINESE_TITLE_LIMIT = 10
const DEFAULT_TITLE_LIMIT = 16
const PANEL_TITLE_FALLBACK = "Dline"
const PROGRESS_SUFFIX_PATTERN = /^(.*?)( \(\d+\/\d+\))$/
const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u

export interface TaskPanelTitleOptions {
    taskTitle?: string | null
    checklist?: string | null
}

function truncateTitle(title: string): string {
    const characters = Array.from(title)
    const limit = HAN_CHARACTER_PATTERN.test(title) ? CHINESE_TITLE_LIMIT : DEFAULT_TITLE_LIMIT
    return characters.length > limit ? characters.slice(0, limit).join("") : title
}

function formatProgress(checklist: string): string {
    const items = checklist
        .split("\n")
        .map((line) => line.trim())
        .filter(isFocusChainItem)

    if (items.length === 0) {
        return ""
    }

    const completedCount = items.filter(isCompletedFocusChainItem).length
    return ` (${completedCount}/${items.length})`
}

/** Format an editor-panel task title from the task text and canonical checklist state. */
export function formatTaskPanelTitle({ taskTitle, checklist }: TaskPanelTitleOptions): string {
    const baseTitle = truncateTitle(taskTitle?.trim() || PANEL_TITLE_FALLBACK)
    return `${baseTitle}${checklist ? formatProgress(checklist) : ""}`
}

export interface TaskPanelTitleSources {
    /** Text of the persisted `task` row, which exists only once the start input was admitted. */
    taskRow?: string | null
    /** Text the task was created with; known synchronously, before the `task` row exists. */
    initialTask?: string | null
    /** Task text of a read-only history display session. */
    historyTask?: string | null
    checklist?: string | null
}

/**
 * Resolve the editor-panel title from every source a task can have.
 *
 * A new task starts in the background, so the first title sync runs before the
 * `task` row is written; without the initial text the tab keeps the fallback
 * title for the whole task.
 */
export function resolveTaskPanelTitle({ taskRow, initialTask, historyTask, checklist }: TaskPanelTitleSources): string {
    const taskTitle = [taskRow, initialTask, historyTask].find((text) => text?.trim())
    return formatTaskPanelTitle({ taskTitle, checklist })
}

/** Normalize a title supplied by any panel entry point while preserving a progress suffix. */
export function normalizeTaskPanelTitle(title: string): string {
    const normalizedTitle = title.trim() || PANEL_TITLE_FALLBACK
    const progressMatch = normalizedTitle.match(PROGRESS_SUFFIX_PATTERN)
    if (!progressMatch) {
        return truncateTitle(normalizedTitle)
    }

    const baseTitle = truncateTitle(progressMatch[1])
    return progressMatch[2] === " (0/0)" ? baseTitle : `${baseTitle}${progressMatch[2]}`
}
