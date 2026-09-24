import type { Command, HaltStopCommand, ParticipantId } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import { executorFailure, type HaltOrder, type HaltParticipant, type TaskEventSink } from "../contracts"

export interface HaltCommandExecutorOptions {
	readonly timeoutMs?: number
	readonly onParticipantFailure?: (participantId: ParticipantId, error: unknown) => void
}

/** Marks the one failure that means "still running" rather than "stopped badly". */
const HALT_TIMEOUT_NAME = "HaltTimeout"

function isDeadlineMiss(error: unknown): boolean {
	return error instanceof Error && error.name === HALT_TIMEOUT_NAME
}

/** Coordinates the nine-domain quiescence barrier without owning any domain resource itself. */
export class HaltCommandExecutor implements CommandExecutor {
	readonly domain = "halt" as const
	private readonly participants = new Map<ParticipantId, HaltParticipant>()
	private readonly operations = new Map<string, Promise<void>>()
	private readonly quiescence = new Map<string, ReadonlyMap<ParticipantId, Promise<void>>>()
	private readonly completedHaltIds = new Set<string>()
	private readonly timeoutMs: number
	private readonly onParticipantFailure: (participantId: ParticipantId, error: unknown) => void

	constructor(
		participants: readonly HaltParticipant[],
		private readonly events: TaskEventSink,
		options: HaltCommandExecutorOptions = {},
	) {
		for (const participant of participants) {
			if (this.participants.has(participant.id)) throw new Error(`Duplicate halt participant: ${participant.id}`)
			this.participants.set(participant.id, participant)
		}
		this.timeoutMs = options.timeoutMs ?? 5_000
		this.onParticipantFailure = options.onParticipantFailure ?? (() => undefined)
	}

	execute(command: Command): Promise<void> {
		if (command.type !== "halt.stop") return Promise.reject(new Error(`Halt executor cannot run ${command.type}`))
		const existing = this.operations.get(command.haltId)
		if (existing) return existing
		if (this.completedHaltIds.has(command.haltId))
			return Promise.reject(new Error(`Halt id already completed and was not rearmed: ${command.haltId}`))
		const operation = this.run(command).finally(() => this.completedHaltIds.add(command.haltId))
		this.operations.set(command.haltId, operation)
		return operation
	}

	/**
	 * Retire the fences once the stop has settled, under the stop's own deadline.
	 *
	 * The drains are awaited a second time here because a receipt only says the
	 * stop was reported, not that the participant stopped publishing. The wait
	 * must use the same bound as the receipts: awaiting without one made a single
	 * participant that never drains outlive a halt the kernel had already
	 * completed, so the caller waited forever and every later lifecycle operation
	 * queued behind it.
	 *
	 * A participant that misses the deadline keeps its fence. It is still running,
	 * and clearing the fence would let its output reach a task that has stopped.
	 */
	async rearm(haltId: string): Promise<void> {
		const stalled = await this.settleDrains(this.quiescence.get(haltId))
		for (const participant of this.participants.values()) {
			if (stalled.has(participant.id)) continue
			participant.rearm?.(haltId)
		}
		this.operations.delete(haltId)
		this.quiescence.delete(haltId)
		this.completedHaltIds.delete(haltId)
	}

	/** The participants that were still draining when the deadline expired. */
	private async settleDrains(drains: ReadonlyMap<ParticipantId, Promise<void>> | undefined): Promise<Set<ParticipantId>> {
		const stalled = new Set<ParticipantId>()
		if (!drains) return stalled
		await Promise.all(
			[...drains].map(async ([participantId, drain]) => {
				try {
					await this.withTimeout(drain)
				} catch (error) {
					// A drain that rejected has stopped, just badly, and its receipt
					// already reported that. Only an unmet deadline means the
					// participant is still live and must stay fenced.
					if (!isDeadlineMiss(error)) return
					stalled.add(participantId)
					this.onParticipantFailure(participantId, error)
				}
			}),
		)
		return stalled
	}

	private async run(command: HaltStopCommand): Promise<void> {
		const order: HaltOrder = { haltId: command.haltId, generation: command.generation, reason: command.reason }
		const participantIds = [...new Set(command.participantIds)]
		const fenceFailures = new Map<ParticipantId, unknown>()

		// No await is allowed before every participant has installed its publication/admission fence.
		for (const participantId of participantIds) {
			const participant = this.participants.get(participantId)
			if (!participant) {
				fenceFailures.set(participantId, new Error("MissingHaltParticipant"))
				continue
			}
			try {
				participant.fence(order)
			} catch (error) {
				fenceFailures.set(participantId, error)
			}
		}

		const drains = new Map<ParticipantId, Promise<void>>()
		for (const participantId of participantIds) {
			if (fenceFailures.has(participantId)) continue
			const participant = this.participants.get(participantId)!
			const drain = Promise.resolve()
				.then(() => participant.stop(order))
				.then(() => participant.drain(order))
			void drain.catch(() => undefined)
			drains.set(participantId, drain)
		}
		this.quiescence.set(command.haltId, drains)

		await Promise.all(
			participantIds.map(async (participantId) => {
				const fenceFailure = fenceFailures.get(participantId)
				if (fenceFailure) {
					await this.failed(command, participantId, fenceFailure)
					return
				}
				try {
					await this.withTimeout(drains.get(participantId)!)
					await this.receipt(command, participantId, "halt.halted")
				} catch (error) {
					await this.failed(command, participantId, error)
				}
			}),
		)
	}

	private async withTimeout(operation: Promise<void>): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				operation,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						const error = new Error(`Halt timed out after ${this.timeoutMs}ms`)
						error.name = HALT_TIMEOUT_NAME
						reject(error)
					}, this.timeoutMs)
				}),
			])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private async failed(command: HaltStopCommand, participantId: ParticipantId, error: unknown): Promise<void> {
		this.onParticipantFailure(participantId, error)
		await this.receipt(command, participantId, "halt.failed")
	}

	private async receipt(
		command: HaltStopCommand,
		participantId: ParticipantId,
		type: "halt.halted" | "halt.failed",
	): Promise<void> {
		const result = await this.events.submit({
			type,
			generation: command.generation,
			haltId: command.haltId,
			participantId,
		})
		if (result.kind === "rejected") throw new Error(executorFailure(`halt.${participantId}`, new Error("ReceiptRejected")))
	}
}
