import { truncateContent } from "@shared/content-limits"
import type { BackgroundResultDelivery, BackgroundResultDeliveryPort } from "../background/BackgroundResultDeliveryPort"
import type { BackgroundDeliveryLedger, BackgroundDeliveryRecord } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { BackgroundResultsEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "./ActiveTaskSession"

/** Room one delivered result takes, until it turns out it was not delivered. */
export interface BackgroundDeliveryReservation {
    /** Bytes of the result that fit; the rest is cut. */
    readonly bytes: number
    release(): void
}

/**
 * Counts every background result the conversation receives, and lets results
 * wait while it has no room for them. Producers never count what they hand to
 * background delivery, so this is the one place such a result is counted.
 */
export interface BackgroundDeliveryBudget {
    /** Counts a result of `textBytes` delivered now, or undefined when none of it fits. */
    reserveBytes(textBytes: number): BackgroundDeliveryReservation | undefined
}

/** Transfers settled producer output to canonical background intake before acknowledging the producer. */
export class TaskBackgroundIngressOwner implements BackgroundResultDeliveryPort {
    private readonly active = new Map<string, Promise<void>>()
    private activation: Promise<void> | undefined
    private releasing: Promise<void> = Promise.resolve()

    constructor(
        private readonly session: () => ActiveTaskSession,
        private readonly ledger: BackgroundDeliveryLedger,
        private readonly budget?: BackgroundDeliveryBudget,
    ) {}

    /** Replay producer results that were durable before the previous process stopped. */
    activate(): Promise<void> {
        this.activation ??= this.releaseHeld()
        return this.activation
    }

    /**
     * Deliver results that are staged but not yet published, one at a time,
     * while the budget admits them; the rest keep waiting in the ledger.
     *
     * Runs after compaction made room and when the task opens again. Releases
     * are serialized so two triggers never publish the same entry twice.
     */
    releaseHeld(): Promise<void> {
        const release = this.releasing.catch(() => undefined).then(() => this.deliverPending())
        this.releasing = release
        return release
    }

    publish(delivery: BackgroundResultDelivery): Promise<void> {
        const existing = this.active.get(delivery.entryId)
        if (existing) return existing
        const operation = this.stageAndPublish(delivery).finally(() => this.active.delete(delivery.entryId))
        this.active.set(delivery.entryId, operation)
        return operation
    }

    private async deliverPending(): Promise<void> {
        for (const delivery of await this.ledger.listPending()) {
            // A producer is publishing this entry right now; it settles it itself.
            if (this.active.has(delivery.entryId)) continue
            const fitted = this.fit(delivery.text)
            // Results are delivered in order, so a later one never overtakes one still waiting.
            if (!fitted) return
            await this.publishStaged(delivery, fitted, async () => undefined)
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
        const fitted = this.fit(staged.text)
        if (!fitted) {
            // The ledger holds the result durably from here, so the producer may
            // let go of it; compaction or the next activation delivers it.
            await delivery.acknowledge()
            return
        }
        await this.publishStaged(staged, fitted, delivery.acknowledge)
    }

    /** The text to deliver now and the room it took, or undefined when it must wait. */
    private fit(text: string): FittedDelivery | undefined {
        if (!this.budget) return { text }
        const textBytes = Buffer.byteLength(text, "utf8")
        const reservation = this.budget.reserveBytes(textBytes)
        if (!reservation) return undefined
        return {
            text: reservation.bytes < textBytes ? truncateContent(text, reservation.bytes) : text,
            reservation,
        }
    }

    private async publishStaged(
        delivery: BackgroundDeliveryRecord,
        fitted: FittedDelivery,
        acknowledgeProducer: () => void | Promise<void>,
    ): Promise<void> {
        try {
            await this.submit(delivery.entryId, fitted.text)
        } catch (error) {
            // Not delivered, so not in the conversation: the room goes back.
            fitted.reservation?.release()
            throw error
        }
        await this.ledger.acknowledge(delivery.entryId)
        await acknowledgeProducer()
    }

    private async submit(entryId: string, text: string): Promise<void> {
        const session = this.session()
        const envelope: BackgroundResultsEnvelope = { kind: "background_results", text }
        const payloadRef = await session.payloads.put(encodeTaskPayload(envelope))
        const submission = await session.assembly.background.publish({ entryId: entryId as never, payloadRef })
        if (submission.kind === "accepted") {
            await submission.durable
        } else if (submission.kind === "fenced") {
            throw new Error(`BackgroundIngressFenced:${submission.haltId}`)
        } else {
            const current = session.state().intake.background.find((entry) => entry.entryId === entryId)
            if (current?.payloadRef !== payloadRef) throw new Error("BackgroundIngressRejected")
        }
    }
}

interface FittedDelivery {
    readonly text: string
    readonly reservation?: BackgroundDeliveryReservation
}
