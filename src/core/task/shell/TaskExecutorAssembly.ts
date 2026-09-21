import { BackgroundIngressExecutor } from "../executors/background/BackgroundIngressExecutor"
import { CompactionCommandExecutor, type CompactionPort } from "../executors/compaction/CompactionCommandExecutor"
import { ComposeCommandExecutor, type ComposePort } from "../executors/compose/ComposeCommandExecutor"
import type { HaltParticipant, TaskEventSink, TaskEventSubmission } from "../executors/contracts"
import { CoTaskIngressExecutor } from "../executors/cotask/CoTaskIngressExecutor"
import { DialogCommandExecutor, type DialogExecutionPort } from "../executors/dialog/DialogCommandExecutor"
import { HaltCommandExecutor, type HaltCommandExecutorOptions } from "../executors/halt/HaltCommandExecutor"
import { assertCompleteHaltParticipants } from "../executors/halt/participants"
import { type ApprovalPolicyPort, PolicyCommandExecutor } from "../executors/policy/PolicyCommandExecutor"
import { ProviderCommandExecutor, type ProviderExecutionPort } from "../executors/provider/ProviderCommandExecutor"
import { SpawnCoordinator, type SpawnPort } from "../executors/spawn/SpawnCoordinator"
import { ToolCommandExecutor, type ToolCommandExecutorOptions } from "../executors/tool/ToolCommandExecutor"
import type { TaskEvent, TaskState } from "../kernel"
import { type CommandExecutor, type RuntimeDiagnosticSink, type RuntimeFacade, TaskRuntime } from "../runtime"
import type { CommandPublicationStore, ConversationJournal, DurableTaskSnapshot, StateVault, TaskViewPort } from "../stores"

export interface TaskExecutionPorts {
	readonly provider: ProviderExecutionPort
	readonly compose: ComposePort
	readonly compaction: CompactionPort
	readonly dialog: DialogExecutionPort
	readonly policy: ApprovalPolicyPort
	readonly tool: ToolCommandExecutorOptions
	readonly spawn: SpawnPort
}

export interface TaskPersistencePorts {
	readonly vault: StateVault
	readonly taskView: TaskViewPort
	readonly publications: CommandPublicationStore
	readonly journal: ConversationJournal
}

export interface TaskExecutorAssemblyOptions {
	readonly taskId: string
	readonly initialState: TaskState
	readonly persistence: TaskPersistencePorts
	readonly execution: TaskExecutionPorts
	readonly diagnostics?: RuntimeDiagnosticSink
	readonly restoredOutbox?: DurableTaskSnapshot["outbox"]
	readonly halt?: HaltCommandExecutorOptions
}

export interface TaskExecutorAssembly {
	readonly runtime: TaskRuntime
	readonly halt: HaltCommandExecutor
	readonly background: BackgroundIngressExecutor
	readonly cotask: CoTaskIngressExecutor
	readonly executors: readonly CommandExecutor[]
	readonly participants: readonly HaltParticipant[]
}

class BoundTaskEventSink implements TaskEventSink {
	private runtime: RuntimeFacade | undefined

	bind(runtime: RuntimeFacade): void {
		if (this.runtime) throw new Error("Task event sink is already bound")
		this.runtime = runtime
	}

	async submit(event: TaskEvent): Promise<TaskEventSubmission> {
		if (!this.runtime) throw new Error("Task event sink is not bound")
		const result = await this.runtime.submit(event)
		return { kind: result.kind }
	}
}

export function createTaskExecutorAssembly(options: TaskExecutorAssemblyOptions): TaskExecutorAssembly {
	const events = new BoundTaskEventSink()
	let runtime: TaskRuntime | undefined
	const generation = () => {
		if (!runtime) throw new Error("Task runtime is not initialized")
		return runtime.getState().generation
	}

	const provider = new ProviderCommandExecutor(
		options.taskId,
		options.execution.provider,
		options.persistence.journal,
		options.persistence.taskView,
		events,
	)
	const tool = new ToolCommandExecutor(options.execution.tool, events)
	const dialog = new DialogCommandExecutor(options.execution.dialog, events)
	const compose = new ComposeCommandExecutor(options.execution.compose, events)
	const compaction = new CompactionCommandExecutor(options.execution.compaction, events, (projection) =>
		options.persistence.taskView.notifyTransient(options.taskId, projection),
	)
	const policy = new PolicyCommandExecutor(options.execution.policy, events)
	const background = new BackgroundIngressExecutor(generation, events)
	const cotask = new CoTaskIngressExecutor(generation, events)
	const spawn = new SpawnCoordinator(options.execution.spawn, events)
	const participants: readonly HaltParticipant[] = [
		provider,
		tool,
		dialog,
		compose,
		compaction,
		policy,
		background,
		cotask,
		spawn,
	]
	assertCompleteHaltParticipants(participants)
	const halt = new HaltCommandExecutor(participants, events, options.halt)
	const executors: readonly CommandExecutor[] = [provider, tool, dialog, compose, compaction, policy, halt, spawn]

	runtime = new TaskRuntime({
		initialState: options.initialState,
		vault: options.persistence.vault,
		taskView: options.persistence.taskView,
		publications: options.persistence.publications,
		executors,
		diagnostics: options.diagnostics,
		restoredOutbox: options.restoredOutbox,
	})
	events.bind(runtime)
	return { runtime, halt, background, cotask, executors, participants }
}
