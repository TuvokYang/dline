import { createHash } from "node:crypto"

/** One item of a reported checklist, as the wire needs to see it. */
export interface ChecklistItem {
    /** Stable identity of the item text, never the text itself. */
    readonly itemId: string
    /** Whether the reported line marks the item done. */
    readonly done: boolean
}

/** A checklist report the task can compare against its previous one. */
export interface ChecklistReport {
    readonly items: readonly ChecklistItem[]
}

const CHECKLIST_LINE = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/

/**
 * Read the checklist a `task_progress` value carried.
 *
 * The model writes the list as Markdown because it reads it in that form, so the
 * only thing parsed here is the checkbox syntax that gives an item its identity.
 * Everything else — headings, prose, numbering — is ignored rather than guessed
 * at, because an item this parser invents would be a checklist entry the user
 * never had.
 */
export function parseChecklist(markdown: string): ChecklistReport {
    const items: ChecklistItem[] = []
    const seen = new Set<string>()
    for (const line of markdown.split(/\r?\n/)) {
        const match = CHECKLIST_LINE.exec(line)
        if (!match) continue
        const itemId = checklistItemId(match[2])
        // The same item written twice is one item, not two declarations.
        if (seen.has(itemId)) continue
        seen.add(itemId)
        items.push({ itemId, done: match[1] !== " " })
    }
    return { items }
}

/** A stable identity for one item's text, independent of its position. */
export function checklistItemId(text: string): string {
    return createHash("sha256").update(text.trim()).digest("hex").slice(0, 24)
}

/** What changed in one checklist item between two reports. */
export const CHECKLIST_TRANSITIONS = ["declared", "completed", "reopened", "abandoned"] as const
export type ChecklistTransition = (typeof CHECKLIST_TRANSITIONS)[number]

/** One change to report, in the vocabulary the usage contract accepts. */
export interface ChecklistChange {
    readonly itemId: string
    readonly transition: ChecklistTransition
}

/**
 * Compare two checklist reports and report the changes between them.
 *
 * Identity is the item's text, so an item that moved keeps its identity and an
 * item whose text was edited is a new item. That is deliberate: a reworded item
 * is a different requirement, and counting it as a reopen would hide the edit.
 *
 * The first report declares every item without inventing complete/reopen events
 * for items that were already done when the list first appeared in this task.
 */
export function diffChecklist(previous: ChecklistReport | undefined, next: ChecklistReport): ChecklistChange[] {
    const before = new Map(previous?.items.map((item) => [item.itemId, item]) ?? [])
    const after = new Map(next.items.map((item) => [item.itemId, item]))
    const changes: ChecklistChange[] = []

    for (const item of next.items) {
        const previousItem = before.get(item.itemId)
        if (previousItem === undefined) {
            changes.push({ itemId: item.itemId, transition: "declared" })
            // An item born done was finished outside the list's own history, so
            // there is no declaration-to-completion interval to measure.
            continue
        }
        if (previousItem.done === item.done) continue
        changes.push({ itemId: item.itemId, transition: item.done ? "completed" : "reopened" })
    }

    for (const item of before.keys()) {
        if (after.has(item)) continue
        changes.push({ itemId: item, transition: "abandoned" })
    }

    return changes
}
