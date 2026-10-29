import type { Controller } from "@core/controller"
import type { TransitionDraftCarrier, TransitionDraftHold } from "@core/controller/context-transition/ContextTransitionEngine"
import { replyableDialog } from "@core/task/kernel"
import type { ActiveTaskSession } from "@core/task/session/ActiveTaskSession"
import type { ChatContent } from "@shared/ChatContent"
import { isResourceNode } from "@shared/input-semantics/document"
import { DispatchInteractionRequest, type InteractionDraft } from "@shared/proto/dline/task"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import { hasTransitionDraftContent, type TransitionDraftProjection } from "@shared/TransitionDraft"
import { dispatchInteraction } from "./dispatchInteraction"

/** What became of a draft that travelled with a context transition. */
type TransitionDraftOutcome = "none" | "replied" | "rejected"

/** Whether `chatContent` is a draft worth keeping or delivering, by the rule the Webview applies too. */
function isAuthoredDraft(chatContent: ChatContent | undefined): chatContent is ChatContent {
    return chatContent !== undefined && hasTransitionDraftContent({ ...chatContent, text: chatContent.message })
}

/**
 * The draft carrier a Controller gives its transition engines.
 *
 * Both steps act on the task the transition was requested for, and only
 * while it is still the Controller's current task: after a task change the
 * draft belongs to neither dialog.
 */
export function controllerTransitionDraftCarrier(controller: Controller): TransitionDraftCarrier {
    const sessionFor = (taskId: string) => (controller.task?.taskId === taskId ? controller.task : undefined)
    return {
        hold: async (source) => {
            const session = sessionFor(source.taskId)
            return session ? holdTransitionDraft(session, source.chatContent) : "none"
        },
        deliver: async (source) => {
            if (!isAuthoredDraft(source.chatContent)) return "empty"
            const session = sessionFor(source.taskId)
            const outcome = session ? await replyWithTransitionDraft(controller, source.chatContent, session) : "none"
            return outcome === "replied" ? "delivered" : "undelivered"
        },
    }
}

/**
 * Keeps the draft of a switch about to wait on the user, until the dialog it answers takes it.
 *
 * From the confirmation until the commit the draft would otherwise live only
 * in the Webview composer and the transition's memory, and a reload would
 * lose both. `none` means there is nothing to keep or no dialog to keep it
 * for; `failed` means a dialog awaits it and it could not be made durable.
 */
export async function holdTransitionDraft(
    session: ActiveTaskSession,
    chatContent: ChatContent | undefined,
): Promise<TransitionDraftHold> {
    if (!session.transitionDrafts || !isAuthoredDraft(chatContent)) return "none"
    const primary = replyableDialog(session.state())
    if (!primary) return "none"
    const result = await session.transitionDrafts.record(primary.interactionId, {
        text: chatContent.message ?? "",
        images: chatContent.images ?? [],
        files: chatContent.files ?? [],
        ...(chatContent.semanticInput ? { semanticInput: chatContent.semanticInput } : {}),
    })
    if (result === "recorded") return "held"
    // The dialog closed between the check and the record: nothing awaits the draft any more.
    if (result === "refused") return "none"
    Logger.warn(`[transitionDraft] ${session.taskId}: draft not kept (${result})`)
    return "failed"
}

/** The kept transition draft of `session`, as the Webview restores it. */
export async function projectTransitionDraft(session: ActiveTaskSession): Promise<TransitionDraftProjection | undefined> {
    const draft = await session.transitionDrafts?.project()
    return draft ? { taskId: session.taskId, ...draft } : undefined
}

/**
 * The reply a transition draft becomes.
 *
 * A structured draft keeps its document: it is what holds pasted command text
 * inert and places each resource where the user put it. Its resources travel
 * only as document nodes, because the reply path refuses a draft that names
 * them a second time in the flat lists.
 */
function transitionReplyDraftOf(content: ChatContent): InteractionDraft {
    const document = content.semanticInput
    const carriesResources = document?.nodes.some(isResourceNode) ?? false
    return {
        text: content.message ?? "",
        images: carriesResources ? [] : [...(content.images ?? [])],
        files: carriesResources ? [] : [...(content.files ?? [])],
        ...(document ? { semanticInput: toProtoSemanticInputDocument(document) } : {}),
    }
}

/**
 * Answers the awaiting dialog with the draft the user switched with.
 *
 * The Webview hands every switch its composer draft and lets it go only when
 * the switch reports it delivered, so the switch is the one place that can
 * deliver it. It goes through the
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
    if (!session || controller.task !== session || !isAuthoredDraft(chatContent)) return "none"
    const primary = replyableDialog(session.state())
    if (!primary) return "none"
    const state = session.state()
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
            draft: transitionReplyDraftOf(chatContent),
        }),
    )
    return result.accepted ? "replied" : "rejected"
}
