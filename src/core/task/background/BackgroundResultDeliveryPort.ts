import type { BackgroundDeliveryProducerKind } from "../stores"

export interface BackgroundResultDelivery {
	readonly entryId: string
	readonly producerKind: BackgroundDeliveryProducerKind
	readonly producerId: string
	readonly attempt: number
	readonly text: string
	readonly acknowledge: () => void | Promise<void>
}

/** Producer-facing port that durably stages a result before canonical intake publication. */
export interface BackgroundResultDeliveryPort {
	publish(delivery: BackgroundResultDelivery): Promise<void>
}
