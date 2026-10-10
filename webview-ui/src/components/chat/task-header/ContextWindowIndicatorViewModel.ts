import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"

export type ContextWindowSegmentKind = "durable" | "active" | "staged" | "environment"

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

    return {
        contextWindow,
        totalTokens,
        percentage: contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0,
        remainingTokens: Math.max(0, contextWindow - totalTokens),
        displayDenominator,
        segments,
    }
}

function normalizeTokens(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
