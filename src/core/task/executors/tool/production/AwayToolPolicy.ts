import { DlineDefaultTool } from "@shared/tools"
import { isTurnEndingToolName } from "../../../assistant-message-order"

/** Only genuine hand-back calls are suppressed; completion still finishes the task. */
export function isAwayFeedbackTool(toolName: string): boolean {
    return toolName !== DlineDefaultTool.ATTEMPT && isTurnEndingToolName(toolName)
}

/** A planned suppression is durable and can never be upgraded after Away stops. */
export function usesAwayFeedback(toolName: string, active: boolean, disposition?: "away_feedback_only"): boolean {
    return disposition === "away_feedback_only" || (active && isAwayFeedbackTool(toolName))
}
