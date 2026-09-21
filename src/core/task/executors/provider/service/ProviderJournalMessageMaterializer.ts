import type { ClineContent, ClineStorageMessage } from "@shared/messages/content"
import { parseDurableToolResult } from "../../../DurableToolResult"
import type { TaskPayloadStore } from "../../../stores"
import { decodeTaskPayload } from "../../../stores/payload/TaskPayloadCodec"
import type {
	DialogDraftEnvelope,
	DialogSelectionEnvelope,
	EnvironmentDetailsEnvelope,
	ProviderFinalEnvelope,
	TaskHandoffEnvelope,
	ToolResultEnvelope,
	UserInputEnvelope,
} from "../../../stores/payload/TaskPayloadEnvelopes"
import { buildUserFeedbackContent } from "../../../utils/buildUserFeedbackContent"

type JournalPayload =
	| UserInputEnvelope
	| DialogDraftEnvelope
	| DialogSelectionEnvelope
	| EnvironmentDetailsEnvelope
	| ProviderFinalEnvelope
	| ToolResultEnvelope
	| TaskHandoffEnvelope
	| { readonly kind: string; readonly [key: string]: unknown }

function textMessage(text: string): ClineStorageMessage {
	return { role: "user", content: [{ type: "text", text }], ts: Date.now() }
}

/** Rebuilds the provider conversation exclusively from the append-only journal payload sequence. */
export class ProviderJournalMessageMaterializer {
	constructor(private readonly payloads: TaskPayloadStore) {}

	async materialize(payloadRefs: readonly string[]): Promise<ClineStorageMessage[]> {
		const messages: ClineStorageMessage[] = []
		for (const payloadRef of payloadRefs) {
			const payload = decodeTaskPayload<JournalPayload>(await this.payloads.read(payloadRef))
			const message = await this.materializePayload(payload)
			if (message) messages.push(message)
		}
		return messages
	}

	private async materializePayload(payload: JournalPayload): Promise<ClineStorageMessage | undefined> {
		switch (payload.kind) {
			case "user_input": {
				const input = payload as UserInputEnvelope
				const content = await buildUserFeedbackContent(
					// The admitted projection carries the expanded commands and mentions;
					// raw text is only the mirror the chat row renders.
					input.admittedText ?? input.text,
					input.images === undefined ? undefined : [...input.images],
					input.files === undefined ? undefined : [...input.files],
				)
				return content.length === 0 ? undefined : { role: "user", content, ts: Date.now() }
			}
			case "dialog_draft": {
				const draft = payload as DialogDraftEnvelope
				const content = await buildUserFeedbackContent(draft.text, [...draft.images], [...draft.files])
				return content.length === 0 ? undefined : { role: "user", content, ts: Date.now() }
			}
			case "dialog_selection":
				return textMessage((payload as DialogSelectionEnvelope).values.join("\n"))
			case "provider_final": {
				const final = payload as ProviderFinalEnvelope
				const content: ClineContent[] = final.content
					? [...final.content]
					: final.text
						? [{ type: "text", text: final.text }]
						: []
				return content.length === 0 ? undefined : { role: "assistant", content, ts: Date.now() }
			}
			case "tool_result": {
				const result = payload as ToolResultEnvelope
				const canonical = parseDurableToolResult(result.content)
				if (!canonical) throw new Error(`InvalidDurableToolResult:${result.blockId}`)
				return { role: "user", content: [canonical], ts: Date.now() }
			}
			case "task_handoff":
				return textMessage((payload as TaskHandoffEnvelope).context)
			case "environment_details":
				return textMessage((payload as EnvironmentDetailsEnvelope).text)
			case "provider_partial":
				return undefined
			default:
				return undefined
		}
	}
}
