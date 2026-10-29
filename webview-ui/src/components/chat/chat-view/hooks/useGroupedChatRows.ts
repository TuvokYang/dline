import { type AggressiveRenderingSetting, effectiveAggressiveRendering } from "@shared/AggressiveRendering"
import type { UiMessage } from "@shared/ExtensionMessage"
import { useMemo } from "react"
import type { FoldOptions } from "../utils/activityFolds"
import { groupChatRows } from "../utils/messageUtils"

/**
 * Builds the chat's rows at the folding level the chat renders at.
 *
 * The level comes from `effectiveAggressiveRendering`, so a stored choice only
 * takes effect while the remote rollout offers it. `activeAskTs` names the ask the
 * footer is answering; the fold step keeps that row visible.
 */
export function useGroupedChatRows(
    modifiedMessages: UiMessage[],
    visibleMessages: UiMessage[],
    aggressiveRendering: Partial<AggressiveRenderingSetting> | undefined,
    activeAskTs: number | undefined,
): (UiMessage | UiMessage[])[] {
    const level = effectiveAggressiveRendering(aggressiveRendering)
    const options = useMemo<FoldOptions>(() => ({ level, activeAskTs }), [level, activeAskTs])
    return useMemo(() => groupChatRows(modifiedMessages, visibleMessages, options), [modifiedMessages, visibleMessages, options])
}
