import type { Command, TaskSpawnCommand } from "../../kernel"
import type { CommandExecutor } from "../../runtime/v2"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"

export interface SpawnPreparationInput {
	readonly spawnAttempt: string
	readonly handoffRef: string
	readonly signal: AbortSignal
}

export interface SpawnChildReceipt {
	readonly childTaskId: string
}

export interface SpawnLease {
	admit(signal: AbortSignal): Promise<SpawnChildReceipt>
	dispose(reason: string): Promise<void>
}

export interface SpawnPort {
	prepare(input: SpawnPreparationInput): Promise<SpawnLease>
}

interface ActiveSpawn {
	readonly command: TaskSpawnCommand
	readonly controller: AbortController
	completion: Promise<void>
	lease?: SpawnLease
	committed: boolean
}

/** Owns provisional spawn resources until the kernel accepts the spawned receipt. */
export class SpawnCoordinator implements CommandExecutor, HaltParticipant {
	readonly domain = "spawn" as const
	readonly id = "spawn" as const
	private readonly active = new Map<string, ActiveSpawn>()
	private fencedHaltId: string | undefined

	constructor(
		private readonly port: SpawnPort,
		private readonly events: TaskEventSink,
	) {}

	execute(command: Command): Promise<void> {
		if (command.type !== "task.spawn") return Promise.reject(new Error(`Spawn executor cannot run ${command.type}`))
		if (this.fencedHaltId) return Promise.resolve()
		if (this.active.has(command.spawnAttempt))
			return Promise.reject(new Error(`Spawn attempt already active: ${command.spawnAttempt}`))
		const active: ActiveSpawn = {
			command,
			controller: new AbortController(),
			completion: Promise.resolve(),
			committed: false,
		}
		active.completion = this.run(active).finally(() => this.active.delete(command.spawnAttempt))
		this.active.set(command.spawnAttempt, active)
		return active.completion
	}

	fence(order: HaltOrder): void {
		this.fencedHaltId = order.haltId
	}

	async stop(order: HaltOrder): Promise<void> {
		await Promise.all(
			[...this.active.values()].map(async (active) => {
				active.controller.abort(`spawn_${order.reason}`)
				await this.dispose(active, `spawn_${order.reason}`)
			}),
		)
	}

	async drain(_order: HaltOrder): Promise<void> {
		await Promise.allSettled([...this.active.values()].map((active) => active.completion))
	}

	rearm(haltId: string): void {
		if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
	}

	private async run(active: ActiveSpawn): Promise<void> {
		const command = active.command
		try {
			const lease = await this.port.prepare({
				spawnAttempt: command.spawnAttempt,
				handoffRef: command.handoffRef,
				signal: active.controller.signal,
			})
			active.lease = lease
			if (!this.isCurrent(active)) {
				await this.dispose(active, "spawn_cancelled")
				return
			}
			const child = await lease.admit(active.controller.signal)
			if (!this.isCurrent(active)) {
				await this.dispose(active, "spawn_cancelled")
				return
			}
			const result = await this.events.submit({
				type: "lifecycle.spawned",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				spawnAttempt: command.spawnAttempt,
				childTaskId: child.childTaskId,
			})
			if (result.kind === "accepted" && this.isCurrent(active)) active.committed = true
			else await this.dispose(active, "spawn_receipt_rejected")
		} catch (error) {
			let failure = error
			try {
				await this.dispose(active, "spawn_failed")
			} catch (disposeError) {
				failure = disposeError
			}
			if (isExecutionAbort(error, active.controller.signal)) return
			await this.events.submit({
				type: "lifecycle.spawn_failed",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				spawnAttempt: command.spawnAttempt,
				message: executorFailure("spawn", failure),
			})
		}
	}

	private isCurrent(active: ActiveSpawn): boolean {
		return this.active.get(active.command.spawnAttempt) === active && !active.controller.signal.aborted && !this.fencedHaltId
	}

	private async dispose(active: ActiveSpawn, reason: string): Promise<void> {
		if (!active.lease || active.committed) return
		const lease = active.lease
		active.lease = undefined
		await lease.dispose(reason)
	}
}
