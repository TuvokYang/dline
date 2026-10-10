/** Instruction mode derived from the canonical checklist state. */
export interface FocusChainInstructionPolicy {
    readonly kind: "progress" | "terminal"
    readonly requireTaskProgressWhenSupported: boolean
}

/** Select progress or terminal guidance without assuming every tool supports task_progress. */
export function selectFocusChainInstructionPolicy(completedItems: number, totalItems: number): FocusChainInstructionPolicy {
    const complete = totalItems > 0 && completedItems === totalItems
    return complete
        ? { kind: "terminal", requireTaskProgressWhenSupported: false }
        : { kind: "progress", requireTaskProgressWhenSupported: true }
}
