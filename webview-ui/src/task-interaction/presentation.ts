import type { TaskViewAction, TaskViewState } from "@shared/ExtensionMessage"
import type { UiTranslator } from "@/i18n/messages"
import { TaskActionError, type TaskActionFailureReason } from "./task-action-errors"

/** Action identity and its interaction contract, never the host's English label, select the display. */
export function interactionActionLabel(view: TaskViewState, action: TaskViewAction, t: UiTranslator): string {
    const ask = view.activeInteraction?.taskAsk
    if (action.dispatchTarget === "interaction") {
        if (ask === "new_task") {
            if (action.type === "approve") return t("chatInput.interaction.action.start_new_task")
            if (action.type === "reject") return t("chatInput.interaction.regenerateContext")
        }
        if (ask === "report_bug") {
            if (action.type === "approve") return t("chatInput.interaction.openIssue")
            if (action.type === "reject") return t("chatInput.interaction.action.cancel")
        }
        if (ask === "condense" && action.type === "reject") return t("chatInput.interaction.regenerateSummary")
    }
    return t(`chatInput.interaction.action.${action.type}`)
}

/** Store failures as meaning + original diagnostic so a mounted alert follows language changes. */
export type InteractionActionError =
    | { kind: "rejected"; result: string }
    | { kind: "failure"; detail?: string }
    | { kind: "task"; reason: TaskActionFailureReason; actionType?: TaskViewAction["type"] }

export function interactionActionFailure(error: unknown): InteractionActionError {
    if (error instanceof TaskActionError) {
        return { kind: "task", reason: error.reason, actionType: error.actionType }
    }
    return { kind: "failure", detail: error instanceof Error && error.message ? error.message : undefined }
}

export function interactionErrorText(error: InteractionActionError, t: UiTranslator): string {
    if (error.kind === "task") {
        switch (error.reason) {
            case "read_only":
                return t("chatInput.interaction.readOnly")
            case "stop_away_failed":
                return t("chatInput.interaction.stopAwayFailed")
            case "foreground_unavailable":
                return t("chatInput.interaction.foregroundUnavailable")
            case "unsupported":
                return t("chatInput.interaction.unsupportedAction", { action: error.actionType ?? "" })
        }
    }
    if (error.kind === "failure") {
        return error.detail
            ? t("chatInput.interaction.failedDetail", { message: error.detail })
            : t("chatInput.interaction.failed")
    }
    switch (error.result) {
        case "stale_interaction":
            return t("chatInput.interaction.stale")
        case "invalid_runtime_event":
            return t("chatInput.interaction.invalidEvent")
        case "task_read_only":
            return t("chatInput.interaction.readOnly")
        case "invalid_payload":
            return t("chatInput.interaction.invalidPayload")
        default:
            return t("chatInput.interaction.rejected", { result: error.result || t("chatInput.interaction.unknownError") })
    }
}
