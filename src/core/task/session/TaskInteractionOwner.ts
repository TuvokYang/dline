import type { CompleteInteractionRequest, InteractionOutcome, OpenInteractionRequest } from "../interaction/InteractionProtocol"
import { getInteraction } from "../interaction/InteractionRegistry"
import type { DialogActionRule, TaskEvent } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { DialogPresentationEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { TaskInteractionPorts } from "../tools/types/TaskConfig"
import type { ActiveTaskSession } from "./ActiveTaskSession"

interface PendingInteraction {
	resolve(outcome: InteractionOutcome): void
	reject(error: Error): void
}

interface InteractionRequest {
	readonly turnId: string
	readonly interactionId: string
	readonly kind: OpenInteractionRequest["kind"]
	readonly presentation: string
	readonly existingTs?: number
	readonly completionId?: string
}

function actionRules(kind: OpenInteractionRequest["kind"]): readonly DialogActionRule[] {
	const definition = getInteraction(kind)
	const rules = definition.actions.map((item) => ({ actionId: item.type, payloadPolicy: item.payloadPolicy }))
	const enterAction = definition.input.enterAction
	if (!enterAction || rules.some((rule) => rule.actionId === enterAction)) return rules
	return [...rules, { actionId: enterAction, payloadPolicy: "draft" }]
}

/** Owns causal interaction receivers while the kernel remains the lifecycle authority. */
export class TaskInteractionOwner implements TaskInteractionPorts {
	private session?: ActiveTaskSession
	private readonly pending = new Map<string, PendingInteraction>()

	constructor(
		private readonly messages: MessageStateHandler,
		private readonly payloads: TaskPayloadStore,
	) {}

	bind(session: ActiveTaskSession): void {
		if (this.session) throw new Error("Task interaction owner is already bound")
		this.session = session
	}

	open(request: OpenInteractionRequest): Promise<InteractionOutcome> {
		return this.request(request)
	}

	complete(request: CompleteInteractionRequest): Promise<InteractionOutcome> {
		return this.request({ ...request, kind: "completion" })
	}

	async say(request: Parameters<TaskInteractionPorts["say"]>[0]): Promise<void> {
		await this.messages.addToClineMessages({
			ts: request.existingTs ?? Date.now(),
			type: "say",
			say: request.taskSay,
			text: request.presentation,
			images: request.images,
			files: request.files,
		})
	}

	resolve(interactionId: string, outcome: InteractionOutcome): void {
		const pending = this.pending.get(interactionId)
		if (!pending) return
		this.pending.delete(interactionId)
		pending.resolve(outcome)
	}

	dispose(reason = "task_disposed"): void {
		for (const pending of this.pending.values()) pending.reject(new Error(reason))
		this.pending.clear()
	}

	private async request(request: InteractionRequest): Promise<InteractionOutcome> {
		if (this.pending.has(request.interactionId)) throw new Error(`Interaction ${request.interactionId} is already pending`)
		const presentationRef = await this.payloads.put(
			encodeTaskPayload<DialogPresentationEnvelope>({
				kind: "dialog_presentation",
				presentationKind: request.kind,
				body: request.presentation,
				existingTs: request.existingTs,
				completionId: request.completionId,
			}),
		)
		const definition = getInteraction(request.kind)
		const anchorTs = request.existingTs ?? Date.now()
		const anchor = {
			ts: anchorTs,
			type: "ask" as const,
			ask: definition.taskAsk,
			text: request.presentation,
			interactionId: request.interactionId,
			partial: false,
		}
		if (this.messages.clineMessages.some((message) => message.ts === anchorTs))
			await this.messages.finalizeClineMessage(anchor)
		else await this.messages.addToClineMessages(anchor)
		const session = this.requireSession()
		const state = session.state()
		const event: TaskEvent = {
			type: "dialog.requested",
			generation: state.generation,
			interactionId: request.interactionId,
			turnId: request.turnId,
			kind: request.kind,
			presentationRef,
			actionRules: actionRules(request.kind),
		}
		const outcome = new Promise<InteractionOutcome>((resolve, reject) => {
			this.pending.set(request.interactionId, { resolve, reject })
		})
		const result = await session.assembly.runtime.submit(event)
		if (result.kind === "rejected") {
			this.pending.delete(request.interactionId)
			throw new Error(result.reason)
		}
		return outcome
	}

	private requireSession(): ActiveTaskSession {
		if (!this.session) throw new Error("Task interaction owner is not bound")
		return this.session
	}
}
