import type { UiAskQuestion } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { serializeDurableToolResult, toolResultReplayOf } from "../DurableToolResult"
import { interactionKindForToolName, projectInteractionContinuation } from "../interaction/InteractionContinuation"
import type { InteractionOutcome } from "../interaction/InteractionProtocol"
import type { KernelBlock, TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { ConversationJournal, TaskPayloadStore } from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope, ToolResultEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type {
	TaskResumptionPort,
	UnownedDialogContinuationPort,
	UnownedDialogOutcome,
	UnownedDialogResolution,
} from "./UnownedDialogContinuation"

/**
 * Dialogs a tool opens and waits on inside its own execution.
 *
 * When the process that ran the tool is gone, the dialog survives the restore
 * but its tool block does not: hydration cancels it. The user's answer is
 * still the tool's result, so it has to be recorded as that result rather than
 * as new input the model would read as an unrelated message.
 */
const RESTORED_TOOL_DIALOG_KINDS: ReadonlySet<string> = new Set(["followup", "status_acknowledgment"])

export interface RestoredToolDialogPorts {
	readonly state: () => Readonly<TaskState>
	readonly payloads: Pick<TaskPayloadStore, "read" | "put">
	readonly journal: Pick<ConversationJournal, "append">
	readonly messages: Pick<
		MessageStateHandler,
		"clineMessages" | "addToClineMessages" | "updateClineMessage" | "flushMessageUpdate"
	>
	readonly nextPresentationId: () => number
}

/** The option a follow-up answer picked, matched the way the live handler matches it. */
export function selectedFollowupOption(options: readonly string[], text: string | undefined): string | undefined {
	if (!text) return undefined
	return (
		options.find((option) => text === option) ??
		options.filter((option) => text.startsWith(`${option}: `)).sort((left, right) => right.length - left.length)[0]
	)
}

/**
 * Answers a restored tool dialog the way its tool would have.
 *
 * A tool-opened dialog is keyed by its block's `dlineTid`, so the block is
 * found from the interaction alone; the dialog itself is already retired when
 * this runs. The answer is journaled as the block's durable result under an
 * operation id derived from the turn and block, which makes a repeated answer
 * a no-op, and the task then resumes with an empty submission so the next
 * round reads that result. Every other unowned dialog keeps the generic
 * resume path, which submits the answer as ordinary input.
 */
export class RestoredToolDialogContinuation implements UnownedDialogContinuationPort {
	constructor(
		private readonly ports: RestoredToolDialogPorts,
		private readonly resumption: TaskResumptionPort,
		private readonly fallback: UnownedDialogContinuationPort,
	) {}

	accepts(resolution: UnownedDialogResolution): boolean {
		// Stop is accepted here even though it ends a generic dialog: for a
		// restored tool it is still the tool's answer, which the model must see.
		return this.restoredBlock(resolution) !== undefined || this.fallback.accepts(resolution)
	}

	async continue(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
		const block = this.restoredBlock(resolution)
		if (!block) return this.fallback.continue(resolution)
		try {
			const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await this.ports.payloads.read(block.invocationRef))
			const kind = invocation.kind === "tool_invocation" ? interactionKindForToolName(invocation.toolName) : undefined
			if (!kind) return this.fallback.continue(resolution)
			const draft = resolution.outcome.draft
			await this.present(resolution, draft)
			const result = await projectInteractionContinuation({
				kind,
				functionId: invocation.functionId,
				dlineTid: invocation.dlineTid,
				chatContent: { message: draft?.text, images: draft?.images, files: draft?.files },
				actionId: resolution.outcome.actionId,
			})
			const envelope: ToolResultEnvelope = {
				kind: "tool_result",
				blockId: invocation.dlineTid,
				content: serializeDurableToolResult(result, toolResultReplayOf(invocation)),
			}
			const turnId = this.ports.state().turn.turnId
			await this.ports.journal.append({
				operationId: `tool.restored_result:${turnId ?? "none"}:${block.blockId}`,
				payloadRef: await this.ports.payloads.put(encodeTaskPayload(envelope)),
				source: "tool",
				causation: { ...(turnId === undefined ? {} : { turnId }), interactionId: resolution.interactionId },
			})
			await this.resumption.submit(await this.resumption.materialize({}))
			return "continued"
		} catch (error) {
			Logger.error(
				`Failed to continue restored tool interaction ${resolution.interactionId}: ${
					error instanceof Error ? error.message : error
				}`,
			)
			return "failed"
		}
	}

	/** The cancelled block a restored tool dialog belongs to, if this is one. */
	private restoredBlock(resolution: UnownedDialogResolution): KernelBlock | undefined {
		if (!RESTORED_TOOL_DIALOG_KINDS.has(resolution.kind)) return undefined
		return this.ports
			.state()
			.turn.blocks.find((block) => block.blockId === resolution.interactionId && block.phase === "cancelled")
	}

	/** Show the answer as the live handler does: the picked option and one feedback row. */
	private async present(resolution: UnownedDialogResolution, draft: InteractionOutcome["draft"]): Promise<void> {
		const messages = this.ports.messages
		if (resolution.kind === "followup") {
			const index = lastIndexOfInteraction(messages.clineMessages, resolution.interactionId)
			const question = index === -1 ? undefined : parseQuestion(messages.clineMessages[index]?.text)
			const selected = question ? selectedFollowupOption(question.options ?? [], draft?.text) : undefined
			if (question && selected) {
				await messages.updateClineMessage(index, { text: JSON.stringify({ ...question, selected }) })
				await messages.flushMessageUpdate(index)
			}
		}
		if (!draft?.text && !draft?.images.length && !draft?.files.length) return
		await messages.addToClineMessages({
			ts: this.ports.nextPresentationId(),
			type: "say",
			say: "user_feedback",
			text: draft?.text ?? "",
			images: [...(draft?.images ?? [])],
			files: [...(draft?.files ?? [])],
		})
	}
}

function lastIndexOfInteraction(messages: readonly { readonly interactionId?: string }[], interactionId: string): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.interactionId === interactionId) return index
	}
	return -1
}

function parseQuestion(text: string | undefined): UiAskQuestion | undefined {
	if (!text) return undefined
	try {
		const parsed = JSON.parse(text) as UiAskQuestion
		return parsed && typeof parsed === "object" ? parsed : undefined
	} catch {
		return undefined
	}
}
