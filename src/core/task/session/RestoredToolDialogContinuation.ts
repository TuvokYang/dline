import type { UiAskQuestion, UiMessage } from "@shared/ExtensionMessage"
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
const RESTORED_TOOL_DIALOG_KINDS: ReadonlySet<string> = new Set([
	"followup",
	"make_plan",
	"qna_response",
	"generate_report",
	"status_acknowledgment",
	"completion",
])

export interface RestoredToolDialogPorts {
	readonly state: () => Readonly<TaskState>
	readonly payloads: Pick<TaskPayloadStore, "read" | "put">
	readonly journal: Pick<ConversationJournal, "append" | "findByOperation" | "read">
	readonly messages: Pick<
		MessageStateHandler,
		"clineMessages" | "addToClineMessages" | "updateClineMessage" | "flushMessageUpdate"
	>
	readonly nextPresentationId: () => number
	/**
	 * Push an edited row to the view. Persisting a row does not publish it, and
	 * the ask row is already on screen, so without this the picked option only
	 * appears after the next full reload.
	 */
	readonly publishRow?: (row: UiMessage) => Promise<void>
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
		return this.restoredBlock(resolution) !== undefined || (!resolution.queuedInput && this.fallback.accepts(resolution))
	}

	async prepare(resolution: UnownedDialogResolution): Promise<boolean> {
		const block = this.restoredBlock(resolution)
		if (!block) return !resolution.queuedInput
		try {
			const target = await this.target(block, resolution)
			if (!target) return false
			// `continue` submits the answer as ordinary input, which writes its own row.
			if (target.recorded === "failed") return true
			await this.present(resolution, resolution.outcome.draft)
			if (target.recorded === "answered") return true
			const { invocation, kind, turnId, operationId } = target
			const draft = resolution.outcome.draft
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
			const payloadRef = await this.ports.payloads.put(encodeTaskPayload(envelope))
			if (resolution.isCurrent && !resolution.isCurrent()) return false
			await this.ports.journal.append({
				operationId,
				payloadRef,
				source: "tool",
				causation: { ...(turnId === undefined ? {} : { turnId }), interactionId: resolution.interactionId },
			})
			return true
		} catch (error) {
			Logger.error(`Failed to prepare restored tool interaction ${resolution.interactionId}`, error)
			return false
		}
	}

	async continue(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
		const block = this.restoredBlock(resolution)
		if (!block) return resolution.queuedInput ? "declined" : this.fallback.continue(resolution)
		try {
			if (!(await this.prepare(resolution))) return "failed"
			if (this.fallback.accepts(resolution) && (await this.target(block, resolution))?.recorded === "failed") {
				return this.fallback.continue(resolution)
			}
			const input = await this.resumption.materialize({})
			if (resolution.isCurrent && !resolution.isCurrent()) return "declined"
			await this.resumption.submit(input)
			return "continued"
		} catch (error) {
			Logger.error(`Failed to continue restored tool interaction ${resolution.interactionId}`, error)
			return "failed"
		}
	}

	/** The tool behind a restored dialog, or undefined when the dialog does not belong to its block's tool. */
	private async target(block: KernelBlock, resolution: UnownedDialogResolution): Promise<RestoredToolTarget | undefined> {
		const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await this.ports.payloads.read(block.invocationRef))
		const kind = invocation.kind === "tool_invocation" ? interactionKindForToolName(invocation.toolName) : undefined
		if (!kind || kind !== resolution.kind || invocation.dlineTid !== block.blockId) return undefined
		const turnId = this.ports.state().turn.turnId
		const operationId = `tool.restored_result:${turnId ?? "none"}:${block.blockId}`
		return { invocation, kind, turnId, operationId, recorded: await this.recordedResult(operationId, turnId, block.blockId) }
	}

	/**
	 * The durable result the block already has.
	 *
	 * The live runner may have journaled a real answer just before the process
	 * died. When the process was stopped while the tool waited on the dialog,
	 * the runner instead journaled the interruption as the tool's failed
	 * result; the call is then settled and a later answer cannot become its
	 * result, so it has to reach the model as new input.
	 */
	private async recordedResult(operationId: string, turnId: string | undefined, blockId: string): Promise<RecordedResult> {
		if (await this.ports.journal.findByOperation(operationId)) return "answered"
		const state = this.ports.state()
		const lowerBound = state.dialog.primary?.journalWatermark ?? state.journalWatermark
		for (const entry of await this.ports.journal.read(lowerBound)) {
			if (entry.kind !== "message" || entry.source !== "tool" || !entry.payloadRef || entry.causation?.turnId !== turnId)
				continue
			const payload = decodeTaskPayload<ToolResultEnvelope>(await this.ports.payloads.read(entry.payloadRef))
			if (payload.kind === "tool_result" && payload.blockId === blockId) return payload.failed ? "failed" : "answered"
		}
		return "none"
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
				await this.publish(messages.clineMessages[index])
			}
		}
		if (resolution.outcome.feedbackPresented || (!draft?.text && !draft?.images.length && !draft?.files.length)) return
		const interactionId = `tool-feedback:${resolution.interactionId}`
		if (messages.clineMessages.some((message) => message.interactionId === interactionId)) return
		await messages.addToClineMessages({
			ts: this.ports.nextPresentationId(),
			type: "say",
			say: "user_feedback",
			interactionId,
			text: draft?.text ?? "",
			images: [...(draft?.images ?? [])],
			files: [...(draft?.files ?? [])],
		})
	}

	/** View delivery is best effort: the row is already durable. */
	private async publish(row: UiMessage | undefined): Promise<void> {
		if (!row || !this.ports.publishRow) return
		await this.ports.publishRow(row).catch((error: unknown) => {
			Logger.warn(
				`Could not publish restored dialog row ${row.ts}: ${error instanceof Error ? error.message : String(error)}`,
			)
		})
	}
}

/** Whether a restored tool block already has its durable result, and what kind. */
type RecordedResult = "none" | "answered" | "failed"

interface RestoredToolTarget {
	readonly invocation: ToolInvocationEnvelope
	readonly kind: NonNullable<ReturnType<typeof interactionKindForToolName>>
	readonly turnId: string | undefined
	readonly operationId: string
	readonly recorded: RecordedResult
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
