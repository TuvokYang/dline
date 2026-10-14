import {
    type ContextWindowIndicatorSnapshot,
    DURABLE_CONTEXT_PARTS,
    type DurableContextPart,
    readDurableContextComposition,
    splitDurableContext,
} from "@shared/context-window-indicator"

export type ContextWindowSegmentKind = "durable" | "active" | "staged" | "environment"

/** One source of the durable context, sized in whole tokens of the durable figure it splits. */
export interface ContextWindowDurablePartViewModel {
    part: DurableContextPart
    label: string
    tokens: number
    /** Share of the durable segment, 0-100. */
    percentOfDurable: number
}

const DURABLE_GREEN = "var(--vscode-charts-green, #3fb950)"

export const DURABLE_PART_LABELS: Record<DurableContextPart, string> = {
    basePrompt: "System prompt",
    userRules: "User rules",
    skills: "Skills",
    workflows: "Workflows",
    toolDefinitions: "Tool definitions",
    mcpToolDefinitions: "MCP",
    conversation: "Conversation",
}

/** Shades of the durable green, so the parts read as one segment rather than new top-level ones. */
export const DURABLE_PART_COLORS: Record<DurableContextPart, string> = {
    basePrompt: `color-mix(in srgb, ${DURABLE_GREEN} 50%, black)`,
    userRules: `color-mix(in srgb, ${DURABLE_GREEN} 65%, black)`,
    skills: `color-mix(in srgb, ${DURABLE_GREEN} 80%, black)`,
    workflows: `color-mix(in srgb, ${DURABLE_GREEN} 75%, white)`,
    toolDefinitions: `color-mix(in srgb, ${DURABLE_GREEN} 55%, white)`,
    mcpToolDefinitions: `color-mix(in srgb, ${DURABLE_GREEN} 35%, white)`,
    conversation: DURABLE_GREEN,
}

export interface ContextWindowSegmentViewModel {
    kind: ContextWindowSegmentKind
    label: string
    authoritativeTokens: number
    displayTokens: number
    widthPercent: number
}

export interface ContextWindowIndicatorViewModel {
    contextWindow: number
    totalTokens: number
    percentage: number
    remainingTokens: number
    displayDenominator: number
    segments: ContextWindowSegmentViewModel[]
    /** Absent when the snapshot carries no measured prefix, as for requests sent before it was measured. */
    durableBreakdown?: ContextWindowDurablePartViewModel[]
}

export interface ContextWindowIndicatorDisplayTokens {
    active?: number
    staged?: number
}

/** Return the mutually exclusive visible activity amount for the current phase. */
export function getContextWindowActiveTokens(snapshot: ContextWindowIndicatorSnapshot): number {
    if (snapshot.phase === "sending") return normalizeTokens(snapshot.pendingSendTokens)
    if (snapshot.phase === "receiving") return normalizeTokens(snapshot.receivingTokens)
    return 0
}

function getActiveLabel(snapshot: ContextWindowIndicatorSnapshot): string {
    return snapshot.phase === "receiving" ? "Receiving" : "Sending"
}

/** Build the single presentation model shared by the bar, totals, accessibility, and hover details. */
export function createContextWindowIndicatorViewModel(
    snapshot: ContextWindowIndicatorSnapshot,
    displayTokens: ContextWindowIndicatorDisplayTokens = {},
): ContextWindowIndicatorViewModel {
    const contextWindow = normalizeTokens(snapshot.contextWindow)
    const authoritativeTokens = {
        durable: normalizeTokens(snapshot.durableContextTokens),
        active: getContextWindowActiveTokens(snapshot),
        staged: normalizeTokens(snapshot.stagedTokens ?? 0),
        environment: normalizeTokens(snapshot.environmentTokens),
    }
    const displayedTokens = {
        durable: authoritativeTokens.durable,
        active: normalizeTokens(displayTokens.active ?? authoritativeTokens.active),
        staged: normalizeTokens(displayTokens.staged ?? authoritativeTokens.staged),
        environment: authoritativeTokens.environment,
    }
    const totalTokens =
        normalizeTokens(snapshot.durableContextTokens) +
        normalizeTokens(snapshot.pendingSendTokens) +
        normalizeTokens(snapshot.receivingTokens) +
        authoritativeTokens.staged +
        authoritativeTokens.environment
    const displayTotal = Object.values(displayedTokens).reduce((total, tokens) => total + tokens, 0)
    const displayDenominator = Math.max(contextWindow, totalTokens, displayTotal)
    const segments: ContextWindowSegmentViewModel[] = [
        {
            kind: "durable",
            label: "Durable",
            authoritativeTokens: authoritativeTokens.durable,
            displayTokens: displayedTokens.durable,
            widthPercent: displayDenominator > 0 ? Math.min(100, (displayedTokens.durable / displayDenominator) * 100) : 0,
        },
        {
            kind: "active",
            label: getActiveLabel(snapshot),
            authoritativeTokens: authoritativeTokens.active,
            displayTokens: displayedTokens.active,
            widthPercent: displayDenominator > 0 ? Math.min(100, (displayedTokens.active / displayDenominator) * 100) : 0,
        },
        {
            kind: "staged",
            label: "Staged",
            authoritativeTokens: authoritativeTokens.staged,
            displayTokens: displayedTokens.staged,
            widthPercent: displayDenominator > 0 ? Math.min(100, (displayedTokens.staged / displayDenominator) * 100) : 0,
        },
        {
            kind: "environment",
            label: "ENV",
            authoritativeTokens: authoritativeTokens.environment,
            displayTokens: displayedTokens.environment,
            widthPercent: displayDenominator > 0 ? Math.min(100, (displayedTokens.environment / displayDenominator) * 100) : 0,
        },
    ]

    const durableBreakdown = createDurableBreakdown(snapshot, authoritativeTokens.durable)
    return {
        contextWindow,
        totalTokens,
        percentage: contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0,
        remainingTokens: Math.max(0, contextWindow - totalTokens),
        displayDenominator,
        segments,
        ...(durableBreakdown ? { durableBreakdown } : {}),
    }
}

/** Split the durable figure by source; the snapshot arrives as JSON, so its split is validated first. */
function createDurableBreakdown(
    snapshot: ContextWindowIndicatorSnapshot,
    durableTokens: number,
): ContextWindowDurablePartViewModel[] | undefined {
    const composition = readDurableContextComposition(snapshot.durableComposition)
    if (!composition || durableTokens <= 0) return undefined
    const split = splitDurableContext(durableTokens, composition)
    return DURABLE_CONTEXT_PARTS.map((part) => ({
        part,
        label: DURABLE_PART_LABELS[part],
        tokens: split[part],
        percentOfDurable: (split[part] / durableTokens) * 100,
    }))
}

function normalizeTokens(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
