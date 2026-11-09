import { type AggressiveRenderingSetting, effectiveAggressiveRendering } from "@shared/AggressiveRendering"
import type { UiMessage } from "@shared/ExtensionMessage"
import { useMemo } from "react"
import type { FoldOptions } from "../utils/activityFolds"
import { groupChatRows } from "../utils/messageUtils"
import { useFoldRoundUsage } from "./useFoldRoundUsage"

/**
 * Builds the chat's rows at the folding level the chat renders at.
 *
 * The level comes from `effectiveAggressiveRendering`, so a stored choice only
 * takes effect while the remote rollout offers it. `activeAskTs` names the ask the
 * footer is answering; the fold step keeps that row visible.
 *
 * The Provider rounds are read here and handed to the fold step, which is the
 * only way a block header can state generation time, tokens and the token rate:
 * message payloads carry tokens but no timing, so there is nothing on the
 * transcript to derive them from.
 *
 * Expansion is not applied here. A block keeps its row and its header whether it
 * is open or closed; the renderer draws the members beneath the header, so the
 * control that opened a block is still there to close it. Applying an expansion
 * projection here is what used to delete the header together with the toggle.
 */
export function useGroupedChatRows(
    modifiedMessages: UiMessage[],
    visibleMessages: UiMessage[],
    aggressiveRendering: Partial<AggressiveRenderingSetting> | undefined,
    activeAskTs: number | undefined,
    taskOpening?: { readonly taskId?: string; readonly taskInstanceId?: string },
): (UiMessage | UiMessage[])[] {
    const level = effectiveAggressiveRendering(aggressiveRendering)
    const usageByRequest = useFoldRoundUsage(taskOpening?.taskId, taskOpening?.taskInstanceId, modifiedMessages, level !== "none")
    const options = useMemo<FoldOptions>(() => ({ level, activeAskTs, usageByRequest }), [level, activeAskTs, usageByRequest])
    return useMemo(() => groupChatRows(modifiedMessages, visibleMessages, options), [modifiedMessages, visibleMessages, options])
}
