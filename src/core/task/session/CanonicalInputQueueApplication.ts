import { Logger } from "@shared/services/Logger"
import { renderRetainedInputs } from "../continuation/RetainedInputContent"
import { retainedQueueDeliveryEntries } from "../kernel/machines/intake"
import type { RuntimeFacade } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { materializeCanonicalInputQueue } from "../view/materializeCanonicalInputQueue"
import type {
	CanonicalInputQueueDraft,
	CanonicalInputQueueMutation,
	CanonicalInputQueueMutationResult,
	CanonicalQueueAwaitingInteraction,
	CanonicalQueueTurnEndDelivery,
	CanonicalQueueTurnEndPort,
	InputQueueApplicationPort,
} from "./InputQueueApplicationPort"
import type { TaskInputMaterializer } from "./TaskInputMaterializer"

export class CanonicalInputQueueApplication implements InputQueueApplicationPort {
	private readonly payloadCache = new Map<string, UserInputEnvelope>()
	private awaitingTurnEnd: CanonicalQueueAwaitingInteraction | undefined
	private drainPromise: Promise<void> | undefined
	private drainRequested = false

	constructor(
		private readonly runtime: RuntimeFacade,
		private readonly inputs: TaskInputMaterializer,
		private readonly payloads: TaskPayloadStore,
		private readonly turnEnd: CanonicalQueueTurnEndPort,
	) {}

	async mutate(mutation: CanonicalInputQueueMutation): Promise<CanonicalInputQueueMutationResult> {
		const generation = this.runtime.getState().generation
		let event
		let success = "ok"

		switch (mutation.kind) {
			case "enqueue": {
				const input = await this.inputs.materialize(mutation.draft, "queued")
				event = {
					type: "input_queue.enqueued" as const,
					generation,
					entryId: input.entryId,
					payloadRef: input.payloadRef,
				}
				success = input.entryId
				break
			}
			case "toggle_mode":
				event = { type: "input_queue.mode_toggled" as const, generation, entryId: mutation.entryId }
				break
			case "reorder":
				event = {
					type: "input_queue.reordered" as const,
					generation,
					entryId: mutation.entryId,
					targetIndex: mutation.targetIndex,
				}
				break
			case "begin_edit":
				event = { type: "input_queue.edit_started" as const, generation, entryId: mutation.entryId }
				break
			case "commit_edit":
				event = {
					type: "input_queue.edit_committed" as const,
					generation,
					entryId: mutation.entryId,
					payloadRef: await this.inputs.materializePayload(mutation.draft),
				}
				break
			case "cancel_edit":
				event = { type: "input_queue.edit_cancelled" as const, generation, entryId: mutation.entryId }
				break
			case "remove":
				event = { type: "input_queue.removed" as const, generation, entryId: mutation.entryId }
				break
		}

		const submitted = await this.runtime.submit(event)
		if (submitted.kind === "rejected") {
			return {
				accepted: false,
				result: submitted.reason === "capacity_exceeded" ? "queue_full" : "missing_entry",
			}
		}
		try {
			await submitted.receipt.durable
		} catch {
			return { accepted: false, result: "persist_failed" }
		}
		if (mutation.kind === "toggle_mode") {
			const entry = submitted.state.intake.queued.find((candidate) => candidate.entryId === mutation.entryId)
			success = entry?.mode ?? "missing_entry"
		}
		this.requestTurnEndDrain()
		return { accepted: true, result: success }
	}

	project() {
		return materializeCanonicalInputQueue(this.runtime.getState(), this.payloads, this.payloadCache)
	}

	onTurnEndAwaiting(interaction: CanonicalQueueAwaitingInteraction): void {
		this.awaitingTurnEnd = interaction
		this.requestTurnEndDrain()
	}

	private requestTurnEndDrain(): void {
		this.drainRequested = true
		if (this.drainPromise) return
		this.drainPromise = this.drainTurnEndRequests()
			.catch((error) => Logger.error("[inputQueue] Canonical turn-end delivery failed", error))
			.finally(() => {
				this.drainPromise = undefined
				if (this.drainRequested) this.requestTurnEndDrain()
			})
	}

	private async drainTurnEndRequests(): Promise<void> {
		while (this.drainRequested) {
			this.drainRequested = false
			await this.tryTurnEndDelivery()
		}
	}

	private async tryTurnEndDelivery(): Promise<void> {
		const interaction = this.awaitingTurnEnd
		if (!interaction) return
		const deliveryId = `queue:turn_end:${interaction.interactionId}`
		const reserved = await this.runtime.submit({
			type: "input_queue.delivery_reserved",
			generation: this.runtime.getState().generation,
			deliveryId,
			point: "turn_end",
			ownerId: interaction.interactionId,
		})
		if (reserved.kind === "rejected") return
		try {
			await reserved.receipt.durable
		} catch (error) {
			Logger.error(`[inputQueue] Could not persist turn-end reservation ${deliveryId}`, error)
			return
		}

		try {
			const entries = retainedQueueDeliveryEntries(this.runtime.getState().intake, deliveryId)
			if (entries.length === 0) return
			const delivery = await this.materializeTurnEndDelivery(deliveryId, interaction, entries, reserved.state.generation)
			const result = await this.turnEnd.deliverTurnEnd(delivery)
			if (result === "accepted" || result === "uncertain") {
				if (this.awaitingTurnEnd?.interactionId === interaction.interactionId) this.awaitingTurnEnd = undefined
				return
			}
			await this.releaseDelivery(deliveryId, reserved.state.generation)
			if (result === "changed") this.drainRequested = true
			if (result === "stale" && this.awaitingTurnEnd?.interactionId === interaction.interactionId) {
				this.awaitingTurnEnd = undefined
			}
		} catch (error) {
			// Only pre-response failures throw. A response whose durability is unknown
			// reports `uncertain` and must never be retried as unsent input.
			await this.releaseDelivery(deliveryId, reserved.state.generation)
			Logger.error(`[inputQueue] Could not materialize retained delivery ${deliveryId}`, error)
		}
	}

	private async materializeTurnEndDelivery(
		deliveryId: string,
		interaction: CanonicalQueueAwaitingInteraction,
		entries: ReturnType<typeof retainedQueueDeliveryEntries>,
		generation: number,
	): Promise<CanonicalQueueTurnEndDelivery> {
		const payloads = await Promise.all(entries.map((entry) => this.readPayload(entry.payloadRef)))
		const modelText = renderRetainedInputs(payloads.map((payload) => payload.admittedText ?? payload.text ?? ""))
		const presentationText = payloads.map((payload) => payload.text ?? "").join("\n\n")
		const images = payloads.flatMap((payload) => [...(payload.images ?? [])])
		const files = payloads.flatMap((payload) => [...(payload.files ?? [])])
		const singleDocument = payloads.length === 1 ? payloads[0]?.semanticInput : undefined
		const draft = (text: string): CanonicalInputQueueDraft => ({
			text,
			images,
			files,
			...(singleDocument === undefined ? {} : { semanticInput: singleDocument }),
		})
		return {
			deliveryId,
			generation,
			entries: entries.map(({ entryId, payloadRef }) => ({ entryId, payloadRef })),
			interaction,
			mode: entries[0]?.mode ?? "queued",
			modelDraft: draft(modelText),
			presentationDraft: draft(presentationText),
		}
	}

	private async readPayload(payloadRef: string): Promise<UserInputEnvelope> {
		const cached = this.payloadCache.get(payloadRef)
		if (cached) return cached
		const payload = decodeTaskPayload<UserInputEnvelope>(await this.payloads.read(payloadRef))
		if (payload.kind !== "user_input") throw new Error(`Payload ${payloadRef} is not user input`)
		this.payloadCache.set(payloadRef, payload)
		return payload
	}

	private async releaseDelivery(deliveryId: string, generation: number): Promise<void> {
		const released = await this.runtime.submit({
			type: "input_queue.delivery_released",
			generation,
			deliveryId,
		})
		if (released.kind === "accepted") {
			try {
				await released.receipt.durable
			} catch (error) {
				Logger.error(`[inputQueue] Could not persist release for ${deliveryId}`, error)
			}
		}
	}
}
