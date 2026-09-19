import type { Command } from "../../kernel"
import type { CommandExecutor, ExecutorDomain } from "../../runtime/v2"

export type TransitionalCommandHandler = (command: Command) => Promise<void>

export class TransitionalCommandExecutor implements CommandExecutor {
	constructor(
		readonly domain: ExecutorDomain,
		private readonly handler: TransitionalCommandHandler,
	) {}

	execute(command: Command): Promise<void> {
		return this.handler(command)
	}
}

export function transitionalExecutors(
	handlers: Readonly<Partial<Record<ExecutorDomain, TransitionalCommandHandler>>>,
): CommandExecutor[] {
	return Object.entries(handlers).map(([domain, handler]) => new TransitionalCommandExecutor(domain as ExecutorDomain, handler))
}
