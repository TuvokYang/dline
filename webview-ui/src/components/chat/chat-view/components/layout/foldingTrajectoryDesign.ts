import { AGGRESSIVE_RENDERING_LEVELS, type AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { UiMessage } from "@shared/ExtensionMessage"
import { foldActivity, projectFoldExpansion } from "../../utils/activityFolds"
import { buildFoldContext } from "../../utils/foldContext"
import { indexRequestRounds } from "../../utils/messageUtils"

export const DESIGN_FOLDING_MODES = AGGRESSIVE_RENDERING_LEVELS
export type DesignFoldingMode = AggressiveRenderingLevel

/** Compatibility adapter for the reviewed stories; production owns every policy. */
export function designFoldRows(messages: UiMessage[], standardRows: (UiMessage | UiMessage[])[], mode: DesignFoldingMode) {
    return foldActivity(standardRows, { level: mode }, buildFoldContext(messages, indexRequestRounds(messages)))
}

export const openDesignRows = projectFoldExpansion
