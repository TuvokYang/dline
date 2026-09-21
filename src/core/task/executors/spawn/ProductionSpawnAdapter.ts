import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { TaskHandoffEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { SpawnLease, SpawnPort, SpawnPreparationInput } from "./SpawnCoordinator"

export interface SpawnChildReservation {
	readonly childTaskId: string
	admit(signal: AbortSignal): Promise<void>
	dispose(reason: string): Promise<void>
}

export interface SpawnChildLauncher {
	reserve(input: {
		readonly spawnAttempt: string
		readonly handoff: TaskHandoffEnvelope
		readonly signal: AbortSignal
	}): Promise<SpawnChildReservation>
}

export interface ProductionSpawnAdapterOptions {
	readonly payloads: TaskPayloadStore
	readonly launcher: SpawnChildLauncher
}

/** Resolves one immutable handoff and keeps reservation disposal behind SpawnCoordinator. */
export class ProductionSpawnAdapter implements SpawnPort {
	constructor(private readonly options: ProductionSpawnAdapterOptions) {}

	async prepare(input: SpawnPreparationInput): Promise<SpawnLease> {
		if (input.signal.aborted) throw input.signal.reason
		const handoff = decodeTaskPayload<TaskHandoffEnvelope>(await this.options.payloads.read(input.handoffRef))
		if (handoff.kind !== "task_handoff") throw new Error("InvalidTaskHandoffPayload")
		const reservation = await this.options.launcher.reserve({
			spawnAttempt: input.spawnAttempt,
			handoff,
			signal: input.signal,
		})
		return {
			admit: async (signal) => {
				if (signal.aborted) throw signal.reason
				await reservation.admit(signal)
				return { childTaskId: reservation.childTaskId }
			},
			dispose: (reason) => reservation.dispose(reason),
		}
	}
}
