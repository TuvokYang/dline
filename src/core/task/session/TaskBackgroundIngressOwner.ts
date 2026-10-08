import type { BackgroundResultDelivery, BackgroundResultDeliveryPort } from "../background/BackgroundResultDeliveryPort"
import type { BackgroundDeliveryLedger, BackgroundDeliveryRecord } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { BackgroundResultsEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "./ActiveTaskSession"

/** Transfers settled producer output to canonical background intake before acknowledging the producer. */
export class TaskBackgroundIngressOwner implements BackgroundResultDeliveryPort {
	private readonly active = new Map<string, Promise<void>>()
	private activation: Promise<void> | undefined

	constructor(
		private readonly session: () => ActiveTaskSession,
		private readonly ledger: BackgroundDeliveryLedger,
	) {}

	/** Replay producer results that were durable before the previous process stopped. */
	activate(): Promise<void> {
		this.activation ??= this.replayPending()
		return this.activation
	}

	publish(delivery: BackgroundResultDelivery): Promise<void> {
		const existing = this.active.get(delivery.entryId)
		if (existing) return existing
		const operation = this.stageAndPublish(delivery).finally(() => this.active.delete(delivery.entryId))
		this.active.set(delivery.entryId, operation)
		return operation
	}

	private async replayPending(): Promise<void> {
		for (const delivery of await this.ledger.listPending()) {
			await this.publishStaged(delivery, async () => undefined)
		}
	}

	private async stageAndPublish(delivery: BackgroundResultDelivery): Promise<void> {
		const staged = await this.ledger.stage({
			entryId: delivery.entryId,
			producerKind: delivery.producerKind,
			producerId: delivery.producerId,
			attempt: delivery.attempt,
			text: delivery.text,
		})
		if (staged.state === "acknowledged") {
			await delivery.acknowledge()
			return
		}
		await this.publishStaged(staged, delivery.acknowledge)
	}

	private async publishStaged(
		delivery: BackgroundDeliveryRecord,
		acknowledgeProducer: () => void | Promise<void>,
	): Promise<void> {
		const session = this.session()
		const envelope: BackgroundResultsEnvelope = { kind: "background_results", text: delivery.text }
		const payloadRef = await session.payloads.put(encodeTaskPayload(envelope))
		const submission = await session.assembly.background.publish({ entryId: delivery.entryId as never, payloadRef })
		if (submission.kind === "accepted") {
			await submission.durable
		} else if (submission.kind === "fenced") {
			throw new Error(`BackgroundIngressFenced:${submission.haltId}`)
		} else {
			const current = session.state().intake.background.find((entry) => entry.entryId === delivery.entryId)
			if (current?.payloadRef !== payloadRef) throw new Error("BackgroundIngressRejected")
		}
		await this.ledger.acknowledge(delivery.entryId)
		await acknowledgeProducer()
	}
}
