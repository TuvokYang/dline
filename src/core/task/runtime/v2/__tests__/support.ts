import { type Command, createInitialTaskState, type TaskState } from "../../../kernel"
import type { DurableTaskSnapshot, StateVault } from "../../../stores/contracts"
import type { CommandExecutor, ExecutorDomain, RuntimeDiagnostic, RuntimeDiagnosticSink } from "../contracts"
import { deferred } from "../deferred"

export class ControlledVault implements StateVault {
	readonly saves: DurableTaskSnapshot[] = []
	private readonly gates: Array<ReturnType<typeof deferred<void>>> = []
	private readonly saveWaiters: Array<{ count: number; ready: ReturnType<typeof deferred<void>> }> = []

	async load(taskId: string): Promise<DurableTaskSnapshot | undefined> {
		return [...this.saves].reverse().find((snapshot) => snapshot.state.taskId === taskId)
	}

	async save(snapshot: DurableTaskSnapshot): Promise<void> {
		this.saves.push(snapshot)
		for (const waiter of this.saveWaiters) {
			if (this.saves.length >= waiter.count) waiter.ready.resolve()
		}
		const gate = deferred<void>()
		this.gates.push(gate)
		await gate.promise
	}

	resolve(index: number): void {
		this.gates[index]?.resolve()
	}

	reject(index: number, error: Error): void {
		this.gates[index]?.reject(error)
	}

	async waitForSaveCount(count: number): Promise<void> {
		if (this.saves.length >= count) return
		const ready = deferred<void>()
		this.saveWaiters.push({ count, ready })
		await ready.promise
	}
}

export class RecordingExecutor implements CommandExecutor {
	readonly commands: Command[] = []
	readonly completions: Array<ReturnType<typeof deferred<void>>> = []
	private readonly commandWaiters: Array<{ count: number; ready: ReturnType<typeof deferred<void>> }> = []

	constructor(
		readonly domain: ExecutorDomain,
		private readonly autoComplete = true,
	) {}

	async execute(command: Command): Promise<void> {
		this.commands.push(command)
		for (const waiter of this.commandWaiters) {
			if (this.commands.length >= waiter.count) waiter.ready.resolve()
		}
		if (this.autoComplete) return
		const completion = deferred<void>()
		this.completions.push(completion)
		await completion.promise
	}

	async waitForCommandCount(count: number): Promise<void> {
		if (this.commands.length >= count) return
		const ready = deferred<void>()
		this.commandWaiters.push({ count, ready })
		await ready.promise
	}
}

export class RecordingDiagnostics implements RuntimeDiagnosticSink {
	readonly diagnostics: RuntimeDiagnostic[] = []
	record(diagnostic: RuntimeDiagnostic): void {
		this.diagnostics.push(diagnostic)
	}
}

export function runningState(taskId = "task-1"): TaskState {
	return { ...createInitialTaskState(taskId), flow: { phase: "running" } }
}

export async function tick(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}
