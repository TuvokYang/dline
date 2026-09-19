import type { Command } from "../../kernel"
import type { CommandPublicationStore } from "../../stores/contracts"
import type { CommandRouter } from "./CommandRouter"
import type { CommitReceipt, RuntimeDiagnosticSink } from "./contracts"

interface PendingCommand {
	readonly command: Command
	readonly receipt: CommitReceipt
	fenced: boolean
}

function isImmediate(command: Command): boolean {
	return command.type === "dialog.prepare" || command.type === "halt.stop"
}

export class DurableCommandOutbox {
	private readonly pending: PendingCommand[] = []
	private drainPromise: Promise<void> | undefined

	constructor(
		private readonly router: CommandRouter,
		private readonly publications: CommandPublicationStore,
		private readonly diagnostics?: RuntimeDiagnosticSink,
	) {}

	persistableAfter(commands: readonly Command[]): readonly Command[] {
		const haltRevision = commands.find((command) => command.type === "halt.stop")?.originRevision
		const retained = this.pending
			.filter((entry) => !entry.fenced && (haltRevision === undefined || entry.command.originRevision >= haltRevision))
			.map((entry) => entry.command)
		const incoming = commands.filter((command) => !isImmediate(command))
		return [...retained, ...incoming]
	}

	enqueue(commands: readonly Command[], receipt: CommitReceipt): void {
		for (const command of commands) {
			if (command.type === "halt.stop") {
				this.fenceBefore(command.originRevision)
				this.dispatchImmediate(command)
				continue
			}
			if (command.type === "dialog.prepare") {
				this.dispatchImmediate(command)
				continue
			}
			this.pending.push({ command, receipt, fenced: false })
		}
		this.scheduleDrain()
	}

	restore(commands: readonly Command[]): void {
		for (const command of commands)
			this.pending.push({
				command,
				receipt: { revision: command.originRevision, durable: Promise.resolve() },
				fenced: false,
			})
		this.scheduleDrain()
	}

	async whenPublishedThrough(revision: number): Promise<void> {
		while (this.pending.some((entry) => !entry.fenced && entry.command.originRevision <= revision)) {
			this.scheduleDrain()
			if (this.drainPromise) await this.drainPromise
		}
	}

	async whenIdle(): Promise<void> {
		while (this.drainPromise) await this.drainPromise
	}

	get pendingCount(): number {
		return this.pending.filter((entry) => !entry.fenced).length
	}

	private fenceBefore(revision: number): void {
		for (const entry of this.pending) {
			if (entry.command.originRevision < revision) entry.fenced = true
		}
	}

	private dispatchImmediate(command: Command): void {
		try {
			this.router.dispatch(command)
		} catch (error) {
			this.diagnostics?.record({
				source: "outbox",
				code: "immediate_dispatch_failed",
				message: error instanceof Error ? error.message : String(error),
				revision: command.originRevision,
				commandId: command.commandId,
			})
		}
	}

	private scheduleDrain(): void {
		if (this.drainPromise || this.pending.length === 0) return
		this.drainPromise = Promise.resolve()
			.then(() => this.drain())
			.finally(() => {
				this.drainPromise = undefined
				if (this.pending.length > 0) this.scheduleDrain()
			})
	}

	private async drain(): Promise<void> {
		while (this.pending.length > 0) {
			const entry = this.pending[0]
			if (entry.fenced) {
				this.pending.shift()
				continue
			}
			try {
				await entry.receipt.durable
				if (entry.fenced) {
					this.pending.shift()
					continue
				}
				if (!(await this.publications.has(entry.command.commandId))) {
					this.router.dispatch(entry.command)
					await this.publications.mark(entry.command)
				}
			} catch (error) {
				this.diagnostics?.record({
					source: "outbox",
					code: "durable_publish_failed",
					message: error instanceof Error ? error.message : String(error),
					revision: entry.command.originRevision,
					commandId: entry.command.commandId,
				})
			}
			this.pending.shift()
		}
	}
}
