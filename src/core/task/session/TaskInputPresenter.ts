import type { MessageStateHandler } from "../message-state"
import type { TaskInput, TaskInputPresentationPort } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

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
	) {}

	async present(input: TaskInput): Promise<void> {
		const payload = decodeTaskPayload<UserInputEnvelope>(await this.payloads.read(input.payloadRef))
		if (payload.kind !== "user_input") return
		const rows = this.messages.clineMessages
		if (rows.some((row) => row.interactionId === input.entryId)) return
		await this.messages.addToClineMessages({
			ts: Date.now(),
			type: "say",
			say: rows.some((row) => row.type === "say" && row.say === "task") ? "user_feedback" : "task",
			text: payload.text ?? "",
			...(payload.images === undefined ? {} : { images: [...payload.images] }),
			...(payload.files === undefined ? {} : { files: [...payload.files] }),
			interactionId: input.entryId,
		})
	}
}
