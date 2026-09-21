import { type Command, type HydrateForm, type HydrateInput, hydrate, type TaskState } from "../kernel"
import type { RuntimeDiagnosticSink, TaskRuntime } from "../runtime"
import { commandEffectKey } from "../runtime/DurableCommandOutbox"
import type { TaskPayloadStore, TaskViewPort } from "../stores"
import {
	createTaskExecutorAssembly,
	type TaskExecutionPorts,
	type TaskExecutorAssembly,
	type TaskPersistencePorts,
} from "./TaskExecutorAssembly"
import { openTaskPersistence, type TaskPersistenceAssembly } from "./TaskPersistenceAssembly"
import { TaskShell } from "./TaskShell"

export interface TaskExecutionFactoryContext {
	readonly initialState: TaskState
	readonly persistence: TaskPersistenceAssembly
}

export interface OpenTaskShellOptions {
	readonly taskId: string
	readonly openReason: HydrateInput["openReason"]
	readonly execution: TaskExecutionPorts | ((context: TaskExecutionFactoryContext) => TaskExecutionPorts)
	readonly taskView: TaskViewPort
	readonly diagnostics?: RuntimeDiagnosticSink
	readonly persistence?: TaskPersistenceAssembly
}

export type OpenTaskShellResult =
	| {
			readonly kind: "ready"
			readonly form: HydrateForm
			readonly shell: TaskShell
			readonly runtime: TaskRuntime
			readonly assembly: TaskExecutorAssembly
			readonly payloads: TaskPayloadStore
			readonly diagnostics: readonly { readonly code: string; readonly message: string }[]
	  }
	| {
			readonly kind: "read_only"
			readonly reason: string
			readonly diagnostics: readonly { readonly code: string; readonly message: string }[]
	  }

function mergeRestoredCommands(commands: readonly Command[]): readonly Command[] {
	const merged = new Map<string, Command>()
	for (const command of commands) merged.set(commandEffectKey(command), command)
	return [...merged.values()]
}

export async function openTaskShell(options: OpenTaskShellOptions): Promise<OpenTaskShellResult> {
	const persistence = options.persistence ?? (await openTaskPersistence(options.taskId))
	const durable = await persistence.ports.vault.load(options.taskId)
	const restored = hydrate({
		taskId: options.taskId,
		snapshot: durable?.state,
		journalTail: persistence.ports.journal.watermark(),
		openReason: options.openReason,
	})
	if (restored.kind === "read_only") return restored

	const ports: TaskPersistencePorts = { ...persistence.ports, taskView: options.taskView }
	const execution =
		typeof options.execution === "function"
			? options.execution({ initialState: restored.state, persistence })
			: options.execution
	const restoredOutbox = mergeRestoredCommands([...(durable?.outbox ?? []), ...restored.initialCommands])
	const assembly = createTaskExecutorAssembly({
		taskId: options.taskId,
		initialState: restored.state,
		persistence: ports,
		execution,
		diagnostics: options.diagnostics,
		restoredOutbox,
	})
	return {
		kind: "ready",
		form: restored.form,
		shell: new TaskShell(assembly.runtime, assembly.halt),
		runtime: assembly.runtime,
		assembly,
		payloads: persistence.payloads,
		diagnostics: restored.diagnostics,
	}
}
