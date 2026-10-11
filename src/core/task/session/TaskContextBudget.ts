import type { ApiHandler } from "@core/api"
import { ContextBudgetLedger } from "@core/context/context-management/context-budget-ledger"
import { collectContextWindowRequestPressures } from "@core/context/context-management/context-pressure"
import { DEFAULT_TOKEN_PER_BYTE } from "@core/context/context-management/context-window-projection"
import {
    type CompactTriggerOptions,
    getContextWindowInfo,
    resolveConfiguredContextWindow,
} from "@core/context/context-management/context-window-utils"
import { resolveTokenPerByte } from "@core/context/context-management/token-estimation"
import { type ContextWindowIndicatorSnapshot, getContextWindowIndicatorTotalTokens } from "@shared/context-window-indicator"
import type { UiMessage } from "@shared/ExtensionMessage"

export interface TaskContextBudgetSources {
    /** The handler the next request is sent with; a Mode or Profile switch replaces it. */
    readonly api: () => ApiHandler
    /** The occupancy the task header shows, which is the only count of what the conversation holds. */
    readonly indicator: () => ContextWindowIndicatorSnapshot | undefined
    /** Chat rows carrying the exact usage each request reported, used to learn tokens per byte. */
    readonly messages: () => readonly UiMessage[]
    /** The user's context settings; a Maximum context below the model window narrows the window. */
    readonly contextSettings?: () => CompactTriggerOptions
}

/** One ledger per task, reading occupancy from the indicator and the window the user works in. */
export function createTaskContextBudget(sources: TaskContextBudgetSources): ContextBudgetLedger {
    return new ContextBudgetLedger({
        contextWindow: () =>
            resolveConfiguredContextWindow(getContextWindowInfo(sources.api()).contextWindow, sources.contextSettings?.()),
        occupiedTokens: () => {
            const indicator = sources.indicator()
            return indicator ? getContextWindowIndicatorTotalTokens(indicator) : 0
        },
        tokenPerByte: () => {
            const api = sources.api()
            return (
                resolveTokenPerByte(collectContextWindowRequestPressures(sources.messages()), {
                    providerId: api.getProviderId?.(),
                    modelId: api.getModel().id,
                    apiFormat: api.getSelectedApiFormat?.(),
                }) ?? DEFAULT_TOKEN_PER_BYTE
            )
        },
    })
}
