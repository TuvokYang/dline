import type { ContextBudgetLease } from "@core/context/context-management/context-budget-ledger"
import { MAX_TOOL_RESULT_TEXT_BYTES, TOOL_RESULT_SELF_BOUND_BYTES } from "@shared/content-limits"
import type { ToolResultBudget } from "./ToolResultUtils"

export const CONTEXT_BUDGET_HINT =
    "the conversation context is near its budget; request a narrower range, or continue and retry after automatic compaction"

/**
 * Bytes of body one call may return: its share of the round's budget, never above
 * `capBytes`. The shares of all calls together never exceed the round's budget; once
 * a call's share is gone its result keeps only the header and the truncation notice.
 */
export function resolveToolResultBytes(lease: ContextBudgetLease | undefined, capBytes: number): number {
    if (!lease) return capBytes
    return lease.shareBytes(capBytes)
}

/**
 * Bytes a tool that bounds its own result may use: its result budget less the
 * room the call's description takes, so the final bound never cuts it a second
 * time. Without a budget this is the self-bound cap.
 */
export function resolveSelfBoundResultBytes(lease: ContextBudgetLease | undefined): number {
    const frameReserveBytes = MAX_TOOL_RESULT_TEXT_BYTES - TOOL_RESULT_SELF_BOUND_BYTES
    const resultBytes = resolveToolResultBytes(lease, MAX_TOOL_RESULT_TEXT_BYTES)
    return Math.max(Math.floor(resultBytes / 2), resultBytes - frameReserveBytes)
}

/** The budget a result is bounded with, or `undefined` while the absolute cap is the tighter limit. */
export function resolveToolResultBudget(lease: ContextBudgetLease | undefined, capBytes: number): ToolResultBudget | undefined {
    const maxBytes = resolveToolResultBytes(lease, capBytes)
    return maxBytes < capBytes ? { maxBytes, hint: CONTEXT_BUDGET_HINT } : undefined
}
