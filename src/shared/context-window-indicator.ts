import type { Mode } from "./storage/types"

export type ContextWindowIndicatorPhase = "stable" | "sending" | "receiving" | "committing" | "rolling_back"

export type ContextWindowIndicatorLineage =
    | { kind: "baseline" }
    | {
          kind: "ordinary"
          requestId: string
          requestSequence: number
          attemptId: string
      }
    | {
          kind: "compaction_pass"
          operationId: string
          passIndex: number
          attemptIndex: number
          attemptId: string
      }

/** The parts the durable segment is broken into, in display order. */
export const DURABLE_CONTEXT_PARTS = [
    "basePrompt",
    "userRules",
    "skills",
    "workflows",
    "toolDefinitions",
    "mcpToolDefinitions",
    "conversation",
] as const

export type DurableContextPart = (typeof DURABLE_CONTEXT_PARTS)[number]

/** Parts of the prefix every request repeats; the conversation is whatever durable holds beyond them. */
export type DurableContextPrefixPart = Exclude<DurableContextPart, "conversation">

const DURABLE_CONTEXT_PREFIX_PARTS: readonly DurableContextPrefixPart[] = [
    "basePrompt",
    "userRules",
    "skills",
    "workflows",
    "toolDefinitions",
    "mcpToolDefinitions",
]

/**
 * Prefix parts added after compositions were first persisted. A snapshot written
 * before such a part existed counted its tokens under an older part, so reading
 * the missing part as zero keeps that snapshot's total and its other parts intact.
 */
const LATER_PREFIX_PARTS: ReadonlySet<DurableContextPrefixPart> = new Set(["mcpToolDefinitions"])

/**
 * Estimated tokens of the request prefix, split by where it comes from.
 *
 * The prefix is absolute rather than a share of durable: compaction, folded
 * rounds, and provider rebases change only the conversation, so deriving the
 * conversation from the current durable figure keeps the split consistent
 * without re-measuring. `basePrompt` includes the MCP and subagent catalogs;
 * `toolDefinitions` holds Dline's own tool definitions and `mcpToolDefinitions`
 * the native schemas of connected MCP servers' tools.
 */
export type DurableContextComposition = Readonly<Record<DurableContextPrefixPart, number>>

/** Whole tokens per durable part; the parts always sum to the durable figure they split. */
export type DurableContextBreakdown = Readonly<Record<DurableContextPart, number>>

/** Accept a composition only when every prefix part is a non-negative whole token count. */
export function readDurableContextComposition(value: unknown): DurableContextComposition | undefined {
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    const composition: Partial<Record<DurableContextPrefixPart, number>> = {}
    for (const part of DURABLE_CONTEXT_PREFIX_PARTS) {
        const tokens = record[part] === undefined && LATER_PREFIX_PARTS.has(part) ? 0 : record[part]
        if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) return undefined
        composition[part] = tokens
    }
    return composition as DurableContextComposition
}

/**
 * Split a durable figure into the prefix parts and the conversation.
 *
 * The prefix is an estimate while durable may come from a provider count, so a
 * prefix larger than durable is scaled down to fit and leaves no conversation;
 * the largest-remainder rule keeps the whole-token parts summing to durable.
 */
export function splitDurableContext(durableTokens: number, composition: DurableContextComposition): DurableContextBreakdown {
    const durable = Number.isFinite(durableTokens) && durableTokens > 0 ? Math.floor(durableTokens) : 0
    const prefix = DURABLE_CONTEXT_PREFIX_PARTS.map((part) => composition[part])
    const prefixTotal = sumTokens(prefix)
    const fitted = prefixTotal <= durable ? prefix : apportionTokens(prefix, durable)
    const breakdown: Record<DurableContextPart, number> = {
        basePrompt: 0,
        userRules: 0,
        skills: 0,
        workflows: 0,
        toolDefinitions: 0,
        mcpToolDefinitions: 0,
        conversation: durable - sumTokens(fitted),
    }
    DURABLE_CONTEXT_PREFIX_PARTS.forEach((part, index) => {
        breakdown[part] = fitted[index] ?? 0
    })
    return breakdown
}

/** Distribute `total` whole tokens in proportion to `weights` by the largest-remainder rule. */
export function apportionTokens(weights: readonly number[], total: number): number[] {
    const weightTotal = sumTokens(weights)
    if (weightTotal <= 0 || total <= 0) return weights.map(() => 0)
    const exact = weights.map((weight) => (Math.max(0, weight) * total) / weightTotal)
    const whole = exact.map(Math.floor)
    let remainder = total - sumTokens(whole)
    const byFraction = exact
        .map((value, index) => ({ index, fraction: value - (whole[index] ?? 0) }))
        .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
    for (const { index } of byFraction) {
        if (remainder <= 0) break
        whole[index] = (whole[index] ?? 0) + 1
        remainder--
    }
    return whole
}

function sumTokens(values: readonly number[]): number {
    return values.reduce((total, value) => total + Math.max(0, value), 0)
}

/** Authoritative Task-local context-window state consumed by Extension state and the Task Header. */
export interface ContextWindowIndicatorSnapshot {
    taskId: string
    revision: number
    epoch: number
    phase: ContextWindowIndicatorPhase
    durableContextTokens: number
    pendingSendTokens: number
    receivingTokens: number
    /** Request-complete and pending local content not yet committed to the durable request baseline. */
    stagedTokens?: number
    environmentTokens: number
    /** Absent when the request prefix could not be measured, as for snapshots written before it was. */
    durableComposition?: DurableContextComposition
    contextWindow: number
    profileId?: string
    profileName?: string
    mode: Mode
    updatedAt: number
    lineage: ContextWindowIndicatorLineage
}

/** Compatibility total for clients that have not migrated to the segmented indicator. */
export function getContextWindowIndicatorTotalTokens(snapshot: ContextWindowIndicatorSnapshot): number {
    return (
        snapshot.durableContextTokens +
        snapshot.pendingSendTokens +
        snapshot.receivingTokens +
        (snapshot.stagedTokens ?? 0) +
        snapshot.environmentTokens
    )
}
