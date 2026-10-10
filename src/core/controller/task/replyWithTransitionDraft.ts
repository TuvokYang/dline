import type { Controller } from "@core/controller"
import type { ChatContent } from "@shared/ChatContent"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { dispatchInteraction } from "./dispatchInteraction"

/** What became of a draft that travelled with a context transition. */
export type TransitionDraftOutcome = "none" | "replied" | "rejected"

function hasContent(chatContent: ChatContent | undefined): chatContent is ChatContent {
    return Boolean(chatContent?.message?.trim() || chatContent?.images?.length || chatContent?.files?.length)
}

/**
 * Answers the awaiting dialog with the draft the user switched with.
 *
 * The Webview hands a draft to the transition whenever a conversational
 * dialog owns the composer, and clears it once the switch lands, so the
 * switch is the only place left that can deliver it. It goes through the
 * ordinary reply path, which admits a command typed into it like any reply,
 * and it is sent only after the target handler is in place so the answer is
 * requested under the Mode and Profile the user chose.
 *
 * `none` means there was nothing to deliver or no dialog awaiting a reply, in
 * which case the Webview still owns the draft. `rejected` means a dialog was
 * waiting but refused it, and the caller must not report the switch as done.
 *
 * @param session The task the switch was committed on. When the Controller
 * has moved to another task meanwhile, the draft belongs to neither dialog
 * and is not delivered.
 */
export async function replyWithTransitionDraft(
    controller: Controller,
    chatContent: ChatContent | undefined,
    session = controller.task,
): Promise<TransitionDraftOutcome> {
    if (!session || controller.task !== session || !hasContent(chatContent)) return "none"
    const state = session.state()
    const primary = state.dialog.primary
    if (!primary || primary.status !== "awaiting" || primary.receiverGeneration === undefined) return "none"
    if (!primary.actionRules.some((rule) => rule.actionId === "reply")) return "none"
    const result = await dispatchInteraction(
        controller,
        DispatchInteractionRequest.create({
            taskId: session.taskId,
            // The switch was committed on this opening, so the reply speaks for it.
            taskInstanceId: session.taskInstanceId,
            turnId: primary.turnId,
            interactionId: primary.interactionId,
            actionId: "reply",
            stateRevision: state.revision,
            draft: {
                text: chatContent.message ?? "",
                images: [...(chatContent.images ?? [])],
                files: [...(chatContent.files ?? [])],
            },
        }),
    )
    return result.accepted ? "replied" : "rejected"
}
