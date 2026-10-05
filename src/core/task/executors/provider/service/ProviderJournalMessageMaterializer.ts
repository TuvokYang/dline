import type { ClineContent, ClineStorageMessage, ClineUserContent } from "@shared/messages/content"
import { replayDurableToolResult } from "../../../DurableToolResult"
import type { ExplicitInstructionDeclaration } from "../../../explicit-instructions/types"
import type { TaskPayloadStore } from "../../../stores"
import { decodeTaskPayload } from "../../../stores/payload/TaskPayloadCodec"
import type {
	BackgroundResultsEnvelope,
	CompactionContinuation,
	CompactionSummaryEnvelope,
	CoTaskMessageEnvelope,
	DialogDraftEnvelope,
	DialogSelectionEnvelope,
	EnvironmentDetailsEnvelope,
	LegacyMessageEnvelope,
	ProviderFinalEnvelope,
	ProviderInterruptedEnvelope,
	TaskHandoffEnvelope,
	ToolResultEnvelope,
	ToolTerminalManifestEnvelope,
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
	| CoTaskMessageEnvelope
	| EnvironmentDetailsEnvelope
	| ProviderFinalEnvelope
	| ProviderInterruptedEnvelope
	| ToolResultEnvelope
	| ToolTerminalManifestEnvelope
	| TaskHandoffEnvelope
	| TurnContinuationEnvelope
	| LegacyMessageEnvelope
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

/** What one journal payload contributes to the provider conversation. */
export interface MaterializedPayload {
	/** Payload kind, which is what says who wrote a user-role message. */
	readonly kind: string
	/**
	 * Usually one message. A summary carrying a reply the model has not
	 * answered yields that reply as well; a payload that renders nothing yields none.
	 */
	readonly messages: readonly ClineStorageMessage[]
	/** The reply a landed summary carries, handed on when a later span takes the summary. */
	readonly continuation?: CompactionContinuation
	readonly supersededPayloadRefs?: readonly string[]
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
		for (const payloadRef of payloadRefs) messages.push(...(await this.materializeEntry(payloadRef)).messages)
		return messages
	}

	/** Read one payload once and render everything it contributes. */
	async materializeEntry(payloadRef: string): Promise<MaterializedPayload> {
		const payload = decodeTaskPayload<JournalPayload>(await this.payloads.read(payloadRef))
		const messages: ClineStorageMessage[] = []
		const message = await this.materializePayload(payload)
		if (message) messages.push(message)
		messages.push(...(await this.materializeContinuation(payload)))
		const continuation =
			payload.kind === "compaction_summary" ? (payload as CompactionSummaryEnvelope).continuation : undefined
		const supersededPayloadRefs =
			payload.kind === "tool_terminal_manifest"
				? (payload as ToolTerminalManifestEnvelope).supersededPayloadRefs
				: undefined
		return {
			kind: payload.kind,
			messages,
			...(continuation === undefined ? {} : { continuation }),
			...(supersededPayloadRefs === undefined ? {} : { supersededPayloadRefs }),
		}
	}

	/**
	 * A condensed reply the model has not answered returns after its summary.
	 *
	 * The recorded exchange returns as it was, so the reply is still the result
	 * of its call. A summary landed before exchanges were recorded only has the
	 * user-authored text, which returns as ordinary input.
	 */
	private async materializeContinuation(payload: JournalPayload): Promise<ClineStorageMessage[]> {
		if (payload.kind !== "compaction_summary") return []
		const continuation = (payload as CompactionSummaryEnvelope).continuation
		if (!continuation) return []
		if (continuation.exchange && continuation.exchange.length > 0) return structuredClone([...continuation.exchange])
		const content = await buildUserFeedbackContent(
			continuation.text,
			continuation.images === undefined ? undefined : [...continuation.images],
			continuation.files === undefined ? undefined : [...continuation.files],
		)
		return content.length === 0 ? [] : [{ role: "user", content, ts: Date.now() }]
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
				if (content.length === 0) return undefined
				// The producer tells a later request to another model that this turn is foreign.
				return { role: "assistant", content, ts: Date.now(), ...(final.modelInfo ? { modelInfo: final.modelInfo } : {}) }
			}
			case "provider_interrupted": {
				const content = [...(payload as ProviderInterruptedEnvelope).content]
				return content.length === 0 ? undefined : { role: "assistant", content, ts: Date.now() }
			}
			case "tool_result": {
				const result = payload as ToolResultEnvelope
				const content = replayDurableToolResult(result.content)
				if (!content) throw new Error(`InvalidDurableToolResult:${result.blockId}`)
				return { role: "user", content, ts: Date.now() }
			}
			case "tool_terminal_manifest":
				return this.materializeToolTerminalManifest(payload as ToolTerminalManifestEnvelope)
			case "task_handoff":
				return textMessage((payload as TaskHandoffEnvelope).context)
			case "environment_details":
				return textMessage((payload as EnvironmentDetailsEnvelope).text)
			case "background_results":
				return textMessage((payload as BackgroundResultsEnvelope).text)
			case "cotask_message":
				return textMessage((payload as CoTaskMessageEnvelope).text)
			case "turn_continuation":
				return textMessage((payload as TurnContinuationEnvelope).text)
			case "compaction_summary":
				// The summary replaces the conversation from its opening request on,
				// so it opens the next request as user context, as the summary card
				// projection always has; an assistant-first request is invalid for
				// providers that require the conversation to start with the user.
				return textMessage((payload as CompactionSummaryEnvelope).text)
			case "legacy_message":
				// Written by an older build and replayed exactly as it was sent.
				return (payload as LegacyMessageEnvelope).message
			case "provider_partial":
				return undefined
			default:
				return undefined
		}
	}

	private async materializeToolTerminalManifest(
		manifest: ToolTerminalManifestEnvelope,
	): Promise<ClineStorageMessage | undefined> {
		const content: ClineUserContent[] = []
		for (const result of manifest.results) {
			const replay = replayDurableToolResult(result.content)
			if (!replay) throw new Error(`InvalidDurableToolResult:${result.blockId}`)
			content.push(...replay)
			if (!result.feedbackRef) continue
			const feedback = decodeTaskPayload<DialogDraftEnvelope>(await this.payloads.read(result.feedbackRef))
			if (feedback.kind !== "dialog_draft") throw new Error(`InvalidToolApprovalFeedback:${result.blockId}`)
			content.push(...(await buildUserFeedbackContent(feedback.text, [...feedback.images], [...feedback.files])))
		}
		return content.length === 0 ? undefined : { role: "user", content, ts: Date.now() }
	}
}
