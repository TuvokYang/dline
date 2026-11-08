import type { TaskReasoningOverrideError } from "@shared/task-reasoning"
import type { UiTranslator } from "@/i18n/messages"

export function thinkingEffortLabel(effort: string, t: UiTranslator): string {
    switch (effort) {
        case "none":
        case "minimal":
        case "low":
        case "medium":
        case "high":
        case "xhigh":
        case "max":
            return t(`chatInput.runtime.effort.${effort}`)
        // A provider may define additional effort identifiers. Keep its declared value, not a guessed translation.
        default:
            return effort.replace(/^./, (character) => character.toUpperCase())
    }
}

export type RuntimeControlError =
    | { kind: "rpc"; detail?: string }
    | {
          kind: "validation"
          error: TaskReasoningOverrideError
          minimum?: number
          maximum?: number
          cannotDisable: boolean
          invalidBounds: boolean
      }

export function runtimeControlErrorText(error: RuntimeControlError, t: UiTranslator): string {
    if (error.kind === "rpc")
        return error.detail ? t("chatInput.runtime.errorDetail", { message: error.detail }) : t("chatInput.runtime.updateError")
    switch (error.error) {
        case "invalid_budget":
            return t("chatInput.runtime.invalidBudget")
        case "negative_budget":
            return t("chatInput.runtime.negativeBudget")
        case "budget_below_min":
            return t("chatInput.runtime.minimumBudget", { minimum: error.minimum ?? 0 })
        case "budget_exceeds_max":
            return t("chatInput.runtime.maximumBudget", { maximum: error.maximum ?? 0 })
        case "unsupported_budget":
            if (error.cannotDisable) return t("chatInput.runtime.cannotDisable")
            if (error.invalidBounds) return t("chatInput.runtime.invalidBounds")
            return t("chatInput.runtime.unsupportedBudget")
        default:
            return t("chatInput.runtime.updateError")
    }
}
