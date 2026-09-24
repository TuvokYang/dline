import type { ClineContent, ClineStorageMessage } from "@shared/messages/content"
import { replayDurableToolResult } from "../../../DurableToolResult"
import type { ExplicitInstructionDeclaration } from "../../../explicit-instructions/types"
import type { TaskPayloadStore } from "../../../stores"
import { decodeTaskPayload } from "../../../stores/payload/TaskPayloadCodec"
import type {
	BackgroundResultsEnvelope,
	CompactionSummaryEnvelope,
	DialogDraftEnvelope,
	DialogSelectionEnvelope,
	EnvironmentDetailsEnvelope,
	ProviderFinalEnvelope,
	TaskHandoffEnvelope,
	ToolResultEnvelope,
	TurnContinuationEnvelope,
	UserInputEnvelope,
} from "../../../stores/payload/TaskPayloadEnvelopes"
import { buildUserFeedbackContent } from "../../../utils/buildUserFeedbackContent"

type JournalPayload =
	| UserInputEnvelope
	| CompactionSummaryEnvelope
	| DialogDraftEnvelope
	| DialogSelectionEnvelope
	| BackgroundResultsEnvelope
	| EnvironmentDetailsEnvelope
	| ProviderFinalEnvelope
	| ToolResultEnvelope
	| TaskHandoffEnvelope
	| TurnContinuationEnvelope
	| { readonly kind: string; readonly [key: string]: unknown }

function textMessage(text: string): ClineStorageMessage {
	return { role: "user", content: [{ type: "text", text }], ts: Date.now() }
}

/** Join a submission with the context recorded alongside it, keeping either side optional. */
function appendSubmissionContext(text: string | undefined, context: string | undefined): string | undefined {
	const trimmedContext = context?.trim()
	if (!trimmedContext) return text
	return text ? `${text}\n\n${trimmedContext}` : trimmedContext
}

/** Rebuilds the provider conversation exclusively from the append-only journal payload sequence. */
export class ProviderJournalMessageMaterializer {
	constructor(private readonly payloads: TaskPayloadStore) {}

	/**
	 * Collect the one-shot authority the admitted inputs of this turn granted.
	 *
	 * Authority is read from the same durable payloads the conversation is built
	 * from, so a replayed or recovered turn carries the same authorization the
	 * user granted when they named the command.
	 */
	async collectAuthority(payloadRefs: readonly string[]): Promise<readonly ExplicitInstructionDeclaration[]> {
		const declarations: ExplicitInstructionDeclaration[] = []
		for (const payloadRef of payloadRefs) {
			const payload = decodeTaskPayload<JournalPayload>(await this.payloads.read(payloadRef))
			if (payload.kind !== "user_input") continue
			declarations.push(...((payload as UserInputEnvelope).explicitInstructions ?? []))
		}
		return declarations
	}

	async materialize(payloadRefs: readonly string[]): Promise<ClineStorageMessage[]> {
		const messages: ClineStorageMessage[] = []
		for (const payloadRef of payloadRefs) {
			const payload = decodeTaskPayload<JournalPayload>(await this.payloads.read(payloadRef))
			const message = await this.materializePayload(payload)
			if (message) messages.push(message)
			const continuation = await this.materializeContinuation(payload)
			if (continuation) messages.push(continuation)
		}
		return messages
	}

	/** A condensed reply the model has not answered returns after its summary, as the user wrote it. */
	private async materializeContinuation(payload: JournalPayload): Promise<ClineStorageMessage | undefined> {
		if (payload.kind !== "compaction_summary") return undefined
		const continuation = (payload as CompactionSummaryEnvelope).continuation
		if (!continuation) return undefined
		const content = await buildUserFeedbackContent(
			continuation.text,
			continuation.images === undefined ? undefined : [...continuation.images],
			continuation.files === undefined ? undefined : [...continuation.files],
		)
		return content.length === 0 ? undefined : { role: "user", content, ts: Date.now() }
	}

	private async materializePayload(payload: JournalPayload): Promise<ClineStorageMessage | undefined> {
		switch (payload.kind) {
			case "user_input": {
				const input = payload as UserInputEnvelope
				const content = await buildUserFeedbackContent(
					// The admitted projection carries the expanded commands and mentions;
					// raw text is only the mirror the chat row renders. Submission context
					// such as a TaskStart hook or a spawn handoff is separate from what the
					// user typed, so it has to be appended rather than replace the text.
					appendSubmissionContext(input.admittedText ?? input.text, input.context),
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
				const content = replayDurableToolResult(result.content)
				if (!content) throw new Error(`InvalidDurableToolResult:${result.blockId}`)
				return { role: "user", content, ts: Date.now() }
			}
			case "task_handoff":
				return textMessage((payload as TaskHandoffEnvelope).context)
			case "environment_details":
				return textMessage((payload as EnvironmentDetailsEnvelope).text)
			case "background_results":
				return textMessage((payload as BackgroundResultsEnvelope).text)
			case "turn_continuation":
				return textMessage((payload as TurnContinuationEnvelope).text)
			case "compaction_summary": {
				// The summary speaks for the assistant turns it replaced, so it
				// takes their role; a user-role summary would read as new input.
				const text = (payload as CompactionSummaryEnvelope).text
				return { role: "assistant", content: [{ type: "text", text }], ts: Date.now() }
			}
			case "provider_partial":
				return undefined
			default:
				return undefined
		}
	}
}
