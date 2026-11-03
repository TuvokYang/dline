import { isCompletedFocusChainItem } from "@shared/focus-chain-utils"
import {
    extractExampleItems,
    extractFocusChainItemsFromText,
    getUncheckedFocusChainItemAtIndex,
    hasChecklistTitle,
    hasNewChecklistHeader,
    hasUncheckedFocusChainItem,
    isAllItemsCompleted,
    mergeCompletedItems,
    mergeInProgressItem,
} from "./file-utils"
import { FocusChainPrompts } from "./prompts"

export interface ChecklistUpdateState {
    readonly checklist: string | null
    readonly currentItem: number | null
    readonly warnedSkip: boolean
}

export type ChecklistUpdateDecision =
    | {
          readonly kind: "accepted"
          readonly checklist: string
          readonly currentItem: number | null
          readonly archive?: string
          readonly warnSkip?: true
      }
    | { readonly kind: "rejected"; readonly message: string; readonly diagnostic?: string; readonly blockTools?: true }

/** Evaluate against the last committed list; no state, file, or presentation is changed here. */
export function evaluateChecklistUpdate(state: ChecklistUpdateState, report: string): ChecklistUpdateDecision {
    if (state.checklist === report) return { kind: "accepted", checklist: report, currentItem: state.currentItem }
    const newChecklist = hasChecklistTitle(report)
    if (hasNewChecklistHeader(report) && !newChecklist) {
        return {
            kind: "rejected",
            message: FocusChainPrompts.titleRequired,
            diagnostic: "Focus Chain: A new checklist requires a # Title. Update rejected.",
        }
    }
    if (newChecklist && !hasUncheckedFocusChainItem(report)) {
        return {
            kind: "rejected",
            message: FocusChainPrompts.uncheckedItemRequired,
            diagnostic: "Focus Chain: A new checklist requires at least one unchecked item. Update rejected.",
        }
    }
    const previous = state.checklist
    if (newChecklist) {
        if (previous && !isAllItemsCompleted(previous)) {
            return { kind: "rejected", message: FocusChainPrompts.tamperingRejected }
        }
        return { kind: "accepted", checklist: report, currentItem: null, ...(previous ? { archive: previous } : {}) }
    }
    if (!previous) return { kind: "rejected", message: FocusChainPrompts.recommended }
    if (isAllItemsCompleted(previous)) return { kind: "rejected", message: FocusChainPrompts.allCompletedAlready }

    const examples = () => extractExampleItems(previous, 3).join("\n")
    const reportedItems = extractFocusChainItemsFromText(report)
    const hasCompleted = reportedItems.some(isCompletedFocusChainItem)
    const hasCurrent = reportedItems.some((item) => !isCompletedFocusChainItem(item))
    if (!hasCompleted && hasCurrent) {
        const result = mergeInProgressItem(previous, report)
        if (!result.updatedText) {
            return { kind: "rejected", message: FocusChainPrompts.inProgressMismatchRejected(examples()) }
        }
        return { kind: "accepted", checklist: result.updatedText, currentItem: result.matchedItemIndex }
    }

    const merged = mergeCompletedItems(previous, report)
    if (merged.unmatchedItems.length > 0) {
        return {
            kind: "rejected",
            message: FocusChainPrompts.itemMismatchRejected(
                merged.unmatchedItems.map((item) => `- ${item}`).join("\n"),
                examples(),
            ),
            blockTools: true,
        }
    }
    let checklist = merged.mergedText
    let currentItem = getUncheckedFocusChainItemAtIndex(checklist, state.currentItem) !== null ? state.currentItem : null
    if (hasCompleted && hasCurrent) {
        const current = mergeInProgressItem(checklist, report)
        if (current.updatedText) {
            checklist = current.updatedText
            currentItem = current.matchedItemIndex
        }
    }
    const skipped = skipsNewlyCompletedItem(previous, checklist)
    if (skipped && state.warnedSkip) {
        return { kind: "rejected", message: FocusChainPrompts.skipOrderRejected(examples()) }
    }
    return { kind: "accepted", checklist, currentItem, ...(skipped ? { warnSkip: true as const } : {}) }
}

/** Historical out-of-order completions must not prevent a legitimate backfill. */
function skipsNewlyCompletedItem(previous: string, next: string): boolean {
    const text = (item: string) => item.replace(/^-\s*\[[ xX]\]\s*/, "").trim()
    const oldCompleted = new Set(extractFocusChainItemsFromText(previous).filter(isCompletedFocusChainItem).map(text))
    let seenUnchecked = false
    for (const item of extractFocusChainItemsFromText(next)) {
        if (!isCompletedFocusChainItem(item)) seenUnchecked = true
        else if (seenUnchecked && !oldCompleted.has(text(item))) return true
    }
    return false
}
