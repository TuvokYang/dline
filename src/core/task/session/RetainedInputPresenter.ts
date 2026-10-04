import type {
	RetainedInputPresentation,
	RetainedInputPresentationCommit,
	RetainedInputPresentationPort,
} from "../executors/compose/RetainedInputPresentationPort"
import type { MessageStateHandler } from "../message-state"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { PresentationIdSequence } from "./PresentationIdSequence"

/** Projects only user-authored content; model guidance never belongs in this row. */
export class RetainedInputPresenter implements RetainedInputPresentationPort {
	constructor(
		private readonly payloads: TaskPayloadStore,
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
	) {}

	async prepare(input: RetainedInputPresentation): Promise<RetainedInputPresentationCommit> {
		const payloads = await Promise.all(
			input.entries.map(async (entry) => {
				const payload = decodeTaskPayload<UserInputEnvelope>(await this.payloads.read(entry.payloadRef))
				if (payload.kind !== "user_input") throw new Error(`InvalidRetainedInput:${entry.entryId}`)
				return payload
			}),
		)
		const row = {
			ts: this.nextPresentationId(),
			type: "say" as const,
			say: "user_feedback" as const,
			text: payloads.map((payload) => payload.text ?? "").join("\n\n"),
			images: payloads.flatMap((payload) => [...(payload.images ?? [])]),
			files: payloads.flatMap((payload) => [...(payload.files ?? [])]),
			interactionId: input.deliveryId,
			userInputKind: "queued" as const,
			queuedInputMode: input.mode,
		}
		return {
			commit: async () => {
				if (this.messages.clineMessages.some((message) => message.interactionId === input.deliveryId)) return
				await this.messages.addToClineMessages(row)
				await this.messages.flushUiMessages()
			},
		}
	}
}
