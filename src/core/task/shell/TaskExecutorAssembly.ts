import { BackgroundIngressExecutor } from "../executors/background/BackgroundIngressExecutor"
import { CompactionCommandExecutor, type CompactionPort } from "../executors/compaction/CompactionCommandExecutor"
import { ComposeCommandExecutor, type ComposePort } from "../executors/compose/ComposeCommandExecutor"
import type { HaltParticipant, TaskEventSink, TaskEventSubmission } from "../executors/contracts"
import { CoTaskIngressExecutor } from "../executors/cotask/CoTaskIngressExecutor"
import {
    type DialogAwaitingPort,
    DialogCommandExecutor,
    type DialogExecutionPort,
    type DialogWaiterPort,
} from "../executors/dialog/DialogCommandExecutor"
import { HaltCommandExecutor, type HaltCommandExecutorOptions } from "../executors/halt/HaltCommandExecutor"
import { assertCompleteHaltParticipants } from "../executors/halt/participants"
import { type ApprovalPolicyPort, PolicyCommandExecutor } from "../executors/policy/PolicyCommandExecutor"
import {
    ProviderCommandExecutor,
    type ProviderExecutionPort,
    type ProviderRoundCheckpointPort,
    type ProviderTextPresentationPort,
} from "../executors/provider/ProviderCommandExecutor"
import type { ProviderRequestReportPort } from "../executors/provider/service/ProviderRequestReport"
import { ToolCommandExecutor, type ToolCommandExecutorOptions } from "../executors/tool/ToolCommandExecutor"
import type { TaskEvent, TaskState } from "../kernel"
import { type CommandExecutor, type RuntimeDiagnosticSink, type RuntimeFacade, TaskRuntime } from "../runtime"
import type { CommandPublicationStore, ConversationJournal, DurableTaskSnapshot, StateVault, TaskViewPort } from "../stores"

/** Everything the provider domain needs: how a turn runs, how it is shown, and what it cost. */
export interface ProviderPorts {
    readonly execution: ProviderExecutionPort
    /** Shows the assistant's prose as a chat row; absent in headless assemblies. */
    readonly presentation?: ProviderTextPresentationPort
    /** Records what each request consumed; absent in headless assemblies. */
    readonly report?: ProviderRequestReportPort
    /** Writes the round's restore point before each request; absent without workspace history. */
    readonly checkpoint?: ProviderRoundCheckpointPort
}

/** Everything the dialog domain needs: how a question is asked, and who awaits it. */
export interface DialogPorts {
    readonly execution: DialogExecutionPort
    /** Receivers to fail when a stop makes their answer impossible; see DialogWaiterPort. */
    readonly waiters?: DialogWaiterPort
    /** Learns when a revealed dialog is durably answerable. */
    readonly awaiting?: DialogAwaitingPort
}

export interface TaskExecutionPorts {
    readonly provider: ProviderPorts
    readonly compose: ComposePort
    readonly compaction: CompactionPort
    readonly dialog: DialogPorts
    readonly policy: ApprovalPolicyPort
    readonly tool: ToolCommandExecutorOptions
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
    /** Hold restored commands until the shell opens the task; see `TaskRuntime`. */
    readonly deferRestoredCommands?: boolean
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
        return result.kind === "accepted" ? { kind: "accepted", durable: result.receipt.durable } : { kind: "rejected" }
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
        options.execution.provider.execution,
        options.persistence.journal,
        options.persistence.taskView,
        events,
        options.execution.provider.presentation,
        options.execution.provider.report,
        options.execution.provider.checkpoint,
    )
    const tool = new ToolCommandExecutor(options.execution.tool, events)
    const dialog = new DialogCommandExecutor(
        options.execution.dialog.execution,
        events,
        options.execution.dialog.waiters,
        options.execution.dialog.awaiting,
    )
    const compose = new ComposeCommandExecutor(options.execution.compose, events)
    const compaction = new CompactionCommandExecutor(options.execution.compaction, events, (projection) =>
        options.persistence.taskView.notifyTransient(options.taskId, projection),
    )
    const policy = new PolicyCommandExecutor(options.execution.policy, events)
    const background = new BackgroundIngressExecutor(generation, events)
    const cotask = new CoTaskIngressExecutor(generation, events)
    const participants: readonly HaltParticipant[] = [provider, tool, dialog, compose, compaction, policy, background, cotask]
    assertCompleteHaltParticipants(participants)
    const halt = new HaltCommandExecutor(participants, events, options.halt)
    const executors: readonly CommandExecutor[] = [provider, tool, dialog, compose, compaction, policy, halt]

    runtime = new TaskRuntime({
        initialState: options.initialState,
        vault: options.persistence.vault,
        taskView: options.persistence.taskView,
        publications: options.persistence.publications,
        executors,
        diagnostics: options.diagnostics,
        restoredOutbox: options.restoredOutbox,
        deferRestoredCommands: options.deferRestoredCommands,
    })
    events.bind(runtime)
    return { runtime, halt, background, cotask, executors, participants }
}
