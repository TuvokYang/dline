import type { Command } from "../kernel"
import type { CommandDispatch, CommandExecutor, ExecutorDomain, RuntimeDiagnosticSink } from "./contracts"

/** The executor domain that owns one command; also the outbox publication lane. */
export function domainFor(command: Command): ExecutorDomain {
	switch (command.type) {
		case "provider.start":
			return "provider"
		case "tool.run":
			return "tool"
		case "dialog.prepare":
		case "dialog.reveal":
			return "dialog"
		case "compose.round":
			return "compose"
		case "compaction.run":
			return "compaction"
		case "approval.evaluate":
			return "policy"
		case "halt.stop":
			return "halt"
		case "task.spawn":
			return "spawn"
	}
}

export class CommandRouter {
	private readonly executors = new Map<ExecutorDomain, CommandExecutor>()
	private readonly active = new Map<string, CommandDispatch>()

	constructor(
		executors: readonly CommandExecutor[],
		private readonly diagnostics?: RuntimeDiagnosticSink,
	) {
		for (const executor of executors) {
			if (this.executors.has(executor.domain)) throw new Error(`Duplicate command executor domain: ${executor.domain}`)
			this.executors.set(executor.domain, executor)
		}
	}

	dispatch(command: Command): CommandDispatch {
		const domain = domainFor(command)
		const executor = this.executors.get(domain)
		if (!executor) throw new Error(`No command executor registered for ${domain}`)
		const completion = Promise.resolve()
			.then(() => executor.execute(command))
			.catch((error) => {
				this.diagnostics?.record({
					source: "router",
					code: "command_failed",
					message: error instanceof Error ? error.message : String(error),
					revision: command.originRevision,
					commandId: command.commandId,
				})
				throw error
			})
		const dispatch = { command, domain, completion }
		this.active.set(command.commandId, dispatch)
		void completion.finally(() => this.active.delete(command.commandId)).catch(() => undefined)
		return dispatch
	}

	async waitForRevision(revision: number): Promise<void> {
		await Promise.all(
			[...this.active.values()]
				.filter((dispatch) => dispatch.command.originRevision <= revision)
				.map((dispatch) => dispatch.completion),
		)
	}

	async waitForQuiescence(): Promise<void> {
		while (this.active.size > 0) await Promise.all([...this.active.values()].map((dispatch) => dispatch.completion))
	}

	get inFlightCount(): number {
		return this.active.size
	}
}
