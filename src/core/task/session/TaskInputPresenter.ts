import type { MessageStateHandler } from "../message-state"
import type { TaskInput, TaskInputPresentationCommit, TaskInputPresentationPort } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { PresentationIdSequence } from "./PresentationIdSequence"

/**
 * Shows the input the runtime accepted as the user's own chat row.
 *
 * The row repeats what the user actually typed, never the admitted projection
 * the provider receives, and it is keyed by the entry identity so a replayed or
 * retried submission reuses the same row instead of duplicating it. The first
 * row of a task is a `task` say because task history takes its title from it.
 */
export class TaskInputPresenter implements TaskInputPresentationPort {
    constructor(
        private readonly payloads: TaskPayloadStore,
        private readonly messages: MessageStateHandler,
        private readonly nextPresentationId: PresentationIdSequence,
    ) {}

    async prepare(input: TaskInput): Promise<TaskInputPresentationCommit> {
        const payload = decodeTaskPayload<UserInputEnvelope>(await this.payloads.read(input.payloadRef))
        const rows = this.messages.clineMessages
        const alreadyShown = rows.some((row) => row.interactionId === input.entryId)
        if (payload.kind !== "user_input" || alreadyShown) return { commit: async () => {} }
        // Recovery sometimes needs an intake event only to start the next round.
        // Its actual user reply is already shown by the restored tool interaction,
        // so rendering the empty continuation as feedback leaves a blank chat row.
        const hasVisibleContent = Boolean(payload.text?.trim() || payload.images?.length || payload.files?.length)
        if (!hasVisibleContent) return { commit: async () => {} }
        // Stamped from the session's shared sequence, and before submission. Rows
        // are ordered by this id, and the submission begins allocating its own
        // ids as soon as it is accepted; a wall-clock reading taken afterwards
        // placed the user's message after the replies to it.
        const row = {
            ts: this.nextPresentationId(),
            type: "say" as const,
            say: rows.some((candidate) => candidate.type === "say" && candidate.say === "task")
                ? ("user_feedback" as const)
                : ("task" as const),
            text: payload.text ?? "",
            ...(payload.images === undefined ? {} : { images: [...payload.images] }),
            ...(payload.files === undefined ? {} : { files: [...payload.files] }),
            interactionId: input.entryId,
        }
        return { commit: () => this.messages.addToClineMessages(row) }
    }
}
