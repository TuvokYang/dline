import type { Command, ToolRunCommand as KernelToolRunCommand, ToolRunBlock } from "../../kernel"
import type { CommandExecutor } from "../../runtime/v2"
import { executorFailure, type HaltOrder, type HaltParticipant, type TaskEventSink } from "../contracts"
import {
	type ToolRunCommand as DomainToolRunCommand,
	type ToolDomainEvent,
	ToolExecutionDomain,
	type ToolExecutionDomainOptions,
} from "./ToolExecutionDomain"

interface PendingBlock {
	readonly command: KernelToolRunCommand
	readonly block: ToolRunBlock
	resolve(): void
}

export type ToolCommandExecutorOptions = Omit<ToolExecutionDomainOptions, "sink">

/** Adapts kernel tool commands to the single WS-072 tool execution domain. */
export class ToolCommandExecutor implements CommandExecutor, HaltParticipant {
	readonly domain = "tool" as const
	readonly id = "tool" as const

	private readonly toolDomain: ToolExecutionDomain
	private readonly pending = new Map<string, PendingBlock>()
	private readonly executions = new Set<Promise<void>>()
	private readonly feedback = new Set<Promise<void>>()
	private fencedHaltId: string | undefined
	private haltPromise: Promise<void> | undefined

	constructor(
		options: ToolCommandExecutorOptions,
		private readonly events: TaskEventSink,
	) {
		this.toolDomain = new ToolExecutionDomain({
			...options,
			sink: {
				emit: (event) => {
					const handling = this.handleDomainEvent(event)
					this.feedback.add(handling)
					void handling.finally(() => this.feedback.delete(handling)).catch(() => undefined)
				},
			},
		})
	}

	execute(command: Command): Promise<void> {
		if (command.type !== "tool.run") return Promise.reject(new Error(`Tool executor cannot run ${command.type}`))
		if (this.fencedHaltId) return Promise.resolve()
		const completion = Promise.all(command.blocks.map((block) => this.executeBlock(command, block))).then(() => undefined)
		this.executions.add(completion)
		void completion.finally(() => this.executions.delete(completion)).catch(() => undefined)
		return completion
	}

	fence(order: HaltOrder): void {
		this.fencedHaltId = order.haltId
		this.toolDomain.fence(order.haltId)
	}

	stop(order: HaltOrder): Promise<void> {
		const reason = order.reason === "close" ? "terminate" : order.reason
		this.haltPromise = this.toolDomain.halt({ haltId: order.haltId, reason })
		return this.haltPromise
	}

	async drain(_order: HaltOrder): Promise<void> {
		if (this.haltPromise) await this.haltPromise
		while (this.feedback.size > 0) await Promise.allSettled([...this.feedback])
		await Promise.allSettled([...this.executions])
	}

	rearm(haltId: string): void {
		if (this.fencedHaltId !== haltId) return
		this.toolDomain.rearm(haltId)
		this.fencedHaltId = undefined
		this.haltPromise = undefined
	}

	private async executeBlock(command: KernelToolRunCommand, block: ToolRunBlock): Promise<void> {
		const started = await this.events.submit({
			type: "tool.started",
			generation: command.generation,
			attempt: block.attempt,
			turnId: command.turnId,
			blockId: block.blockId,
		})
		if (started.kind === "rejected" || this.fencedHaltId) return

		const domainCommand: DomainToolRunCommand = {
			commandId: `${command.commandId}:${block.blockId}:${block.attempt}`,
			turnId: command.turnId,
			dlineTid: block.blockId,
			mode: command.mode,
		}
		const settled = new Promise<void>((resolve) => {
			this.pending.set(domainCommand.commandId, { command, block, resolve })
		})
		this.toolDomain.handle(domainCommand)
		await settled
	}

	private async handleDomainEvent(event: ToolDomainEvent): Promise<void> {
		if (event.kind === "tool.halted") {
			const pending = [...this.pending.entries()]
			await Promise.all(
				pending.map(async ([commandId, entry]) => {
					await this.submitTerminal(entry, "tool.cancelled")
					this.settle(commandId)
				}),
			)
			return
		}

		const entry = this.pending.get(event.commandId)
		if (!entry) return
		if (event.kind === "tool.block_result") await this.submitTerminal(entry, "tool.completed")
		else if (event.kind === "tool.block_failed")
			await this.submitTerminal(entry, "tool.failed", executorFailure("tool", event.cause ?? new Error(event.message)))
		else await this.submitTerminal(entry, "tool.cancelled")
		this.settle(event.commandId)
	}

	private submitTerminal(
		entry: PendingBlock,
		type: "tool.completed" | "tool.failed" | "tool.cancelled",
		message?: string,
	): Promise<unknown> {
		return this.events.submit({
			type,
			generation: entry.command.generation,
			attempt: entry.block.attempt,
			turnId: entry.command.turnId,
			blockId: entry.block.blockId,
			message,
		})
	}

	private settle(commandId: string): void {
		const entry = this.pending.get(commandId)
		if (!entry) return
		this.pending.delete(commandId)
		entry.resolve()
	}
}
