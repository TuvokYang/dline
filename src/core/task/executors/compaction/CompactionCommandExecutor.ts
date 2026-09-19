import type { Command, CompactionRunCommand } from "../../kernel"
import type { CommandExecutor } from "../../runtime/v2"
import { executorFailure, isExecutionAbort, type TaskEventSink } from "../contracts"

export interface CompactionExecutionInput {
	readonly compactionId: string
	readonly attempt: string
	readonly contextRef: string
	readonly signal: AbortSignal
	readonly publish: (projection: Readonly<Record<string, unknown>>) => void
}

export interface CompactionExecutionResult {
	readonly resultRef: string
}

export interface CompactionPort {
	run(input: CompactionExecutionInput): Promise<CompactionExecutionResult>
}

interface ActiveCompaction {
	readonly attempt: string
	readonly controller: AbortController
}

export class CompactionCommandExecutor implements CommandExecutor {
	readonly domain = "compaction" as const
	private readonly active = new Map<string, ActiveCompaction>()

	constructor(
		private readonly port: CompactionPort,
		private readonly events: TaskEventSink,
		private readonly publish: (projection: Readonly<Record<string, unknown>>) => void = () => undefined,
	) {}

	async execute(command: Command): Promise<void> {
		if (command.type !== "compaction.run") throw new Error(`Compaction executor cannot run ${command.type}`)
		if (this.active.size > 0) throw new Error("Compaction execution is already active")

		const active: ActiveCompaction = { attempt: command.attempt, controller: new AbortController() }
		this.active.set(command.compactionId, active)
		try {
			const started = await this.events.submit({
				type: "compaction.started",
				generation: command.generation,
				compactionId: command.compactionId,
				attempt: command.attempt,
			})
			if (started.kind === "rejected") return
			if (active.controller.signal.aborted) {
				await this.expire(command, "compaction_cancelled")
				return
			}

			let result: CompactionExecutionResult
			try {
				result = await this.port.run({
					compactionId: command.compactionId,
					attempt: command.attempt,
					contextRef: command.contextRef,
					signal: active.controller.signal,
					publish: (projection) => {
						if (this.isCurrent(command, active) && !active.controller.signal.aborted) this.publish(projection)
					},
				})
			} catch (error) {
				if (isExecutionAbort(error, active.controller.signal)) await this.expire(command, "compaction_cancelled")
				else
					await this.events.submit({
						type: "compaction.failed",
						generation: command.generation,
						compactionId: command.compactionId,
						attempt: command.attempt,
						message: executorFailure("compaction", error),
					})
				return
			}
			if (active.controller.signal.aborted) {
				await this.expire(command, "compaction_cancelled")
				return
			}
			if (!result.resultRef) {
				await this.events.submit({
					type: "compaction.failed",
					generation: command.generation,
					compactionId: command.compactionId,
					attempt: command.attempt,
					message: "compaction execution failed (MissingCompactionResult)",
				})
				return
			}
			await this.events.submit({
				type: "compaction.completed",
				generation: command.generation,
				compactionId: command.compactionId,
				attempt: command.attempt,
				resultRef: result.resultRef,
			})
		} finally {
			this.active.delete(command.compactionId)
		}
	}

	cancel(compactionId: string, reason = "compaction_cancelled"): boolean {
		const active = this.active.get(compactionId)
		if (!active) return false
		active.controller.abort(reason)
		return true
	}

	cancelAll(reason = "compaction_cancelled"): number {
		for (const active of this.active.values()) active.controller.abort(reason)
		return this.active.size
	}

	private isCurrent(command: CompactionRunCommand, active: ActiveCompaction): boolean {
		return this.active.get(command.compactionId) === active && active.attempt === command.attempt
	}

	private expire(command: CompactionRunCommand, message: string): Promise<unknown> {
		return this.events.submit({
			type: "compaction.expired",
			generation: command.generation,
			compactionId: command.compactionId,
			attempt: command.attempt,
			message,
		})
	}
}
