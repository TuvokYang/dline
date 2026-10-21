/**
 * Projection of settled tool blocks into canonical tool-name counters (WS-111).
 *
 * The projection is deliberately the same walk as the existing turn/tool
 * summary: a block is completed, failed or cancelled by exactly the criteria
 * `TaskProviderRequestRoundOwner.summarizeExecutionTools` already uses. Two
 * different classifications of the same block would make `by_name` plus
 * `unlisted` disagree with `tools.<outcome>`, and the reader would reject the
 * whole batch.
 */

import type { BlockPhase } from "@/core/task/kernel"
import {
    MAX_TOOL_NAMES_PER_FACT,
    selectToolNames,
    sumOutcomeCounts,
    type ToolNameCandidate,
    type ToolOutcome,
    type ToolOutcomeCounts,
} from "../contracts/usageExecution"
import { canonicalToolName } from "./executionMetricsCatalog"

/** A settled block as the projection needs to see it. */
export interface SettledToolBlock {
    readonly phase: BlockPhase
    /** The phase of the turn-ending block whose result settles as completed. */
    readonly awaitingBlockId?: string
    /** The wire name of the tool this block invoked, when it could be resolved. */
    readonly toolName?: string
}

/** Outcome of a block, using the same rules as the fact-level tool totals. */
export function toolOutcomeOf(block: SettledToolBlock): ToolOutcome {
    if (block.phase === "completed" || block.awaitingBlockId !== undefined) return "completed"
    // A rejected block never ran, but it did settle without a result, which the
    // fact-level total already reports as a failure.
    if (block.phase === "failed" || block.phase === "rejected") return "failed"
    return "cancelled"
}

export interface ToolNameCounters {
    /** Counters keyed by wire tool name; at most the contract bound. */
    readonly byName: Readonly<Record<string, ToolOutcomeCounts>>
    /** Settlements whose tool name could not be reported. */
    readonly unlisted: ToolOutcomeCounts
    /** The totals this projection accounts for; always equal to the fact totals. */
    readonly totals: ToolOutcomeCounts
}

export interface ProjectToolCountersInput {
    readonly factKey: string
    readonly blocks: readonly SettledToolBlock[]
    readonly limit?: number
}

/**
 * Group settled blocks by tool name, fold what does not fit into `unlisted`,
 * and return totals that the caller can compare against the fact.
 *
 * An unresolvable or unregistered name never invents an identity and never
 * drops the settlement: it becomes `unlisted`. Losing a settlement would break
 * conservation, and inventing a name would merge two different tools.
 */
export function projectToolCounters(input: ProjectToolCountersInput): ToolNameCounters {
    const grouped = new Map<string, ToolOutcomeCounts>()
    const unlisted: Record<ToolOutcome, number> = { completed: 0, failed: 0, cancelled: 0 }
    const totals: Record<ToolOutcome, number> = { completed: 0, failed: 0, cancelled: 0 }

    for (const block of input.blocks) {
        const outcome = toolOutcomeOf(block)
        totals[outcome] += 1
        const name = canonicalToolName(block.toolName)
        if (name === undefined) {
            unlisted[outcome] += 1
            continue
        }
        const current = grouped.get(name) ?? { completed: 0, failed: 0, cancelled: 0 }
        grouped.set(name, { ...current, [outcome]: current[outcome] + 1 })
    }

    const limit = input.limit ?? MAX_TOOL_NAMES_PER_FACT
    const candidates: ToolNameCandidate[] = [...grouped].map(([toolName, counts]) => ({
        factKey: input.factKey,
        toolName,
        ...counts,
    }))
    const { selected, unlisted: folded } = selectToolNames(candidates, limit)

    const byName: Record<string, ToolOutcomeCounts> = {}
    for (const entry of [...selected].sort((left, right) => left.toolName.localeCompare(right.toolName))) {
        byName[entry.toolName] = {
            completed: entry.completed,
            failed: entry.failed,
            cancelled: entry.cancelled,
        }
    }
    const foldedTotals = sumOutcomeCounts(folded)
    const remainder: ToolOutcomeCounts = {
        completed: unlisted.completed + foldedTotals.completed,
        failed: unlisted.failed + foldedTotals.failed,
        cancelled: unlisted.cancelled + foldedTotals.cancelled,
    }

    return {
        byName,
        unlisted: remainder,
        totals: { completed: totals.completed, failed: totals.failed, cancelled: totals.cancelled },
    }
}

/** Whether the projection accounts for every settled block exactly once. */
export function toolCountersConserve(counters: ToolNameCounters): boolean {
    const listed = sumOutcomeCounts(Object.values(counters.byName))
    return (["completed", "failed", "cancelled"] as const).every(
        (outcome) => listed[outcome] + counters.unlisted[outcome] === counters.totals[outcome],
    )
}

/** Whether a projection holds nothing to report and must be omitted from the wire. */
export function isEmptyToolCounters(counters: ToolNameCounters): boolean {
    return (
        Object.keys(counters.byName).length === 0 &&
        counters.unlisted.completed + counters.unlisted.failed + counters.unlisted.cancelled === 0
    )
}
