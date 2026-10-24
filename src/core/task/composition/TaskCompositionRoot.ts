import type { CompactionSettlementObserverPort } from "../compaction/CompactionRoundBarrier"
import { type CompactionLandingPort } from "../compaction/CompactionSummaryLanding"
import {
    type CompactionConversationPort,
    type ContextTruncationPort,
    JournalCompactionConversation,
} from "../compaction/JournalCompactionConversation"
import type { CompactionPort } from "../executors/compaction/CompactionCommandExecutor"
import type {
    CompactionCheckpointPort,
    CompactionFailurePresentationPort,
    CompactionProgressCardPort,
    CompactionReviewPort,
} from "../executors/compaction/ProductionCompactionAdapter"
import {
    ProductionCompactionAdapter,
    type ProductionCompactionService,
} from "../executors/compaction/ProductionCompactionAdapter"
import type { ComposePort } from "../executors/compose/ComposeCommandExecutor"
import {
    type ComposeCompactionBarrierPort,
    type ComposeContextWindowGuardPort,
    type ComposeContinuationPort,
    type ComposeEnvironmentPort,
    ProductionComposeAdapter,
} from "../executors/compose/ProductionComposeAdapter"
import type { RetainedInputPresentationPort } from "../executors/compose/RetainedInputPresentationPort"
import { ToolSequenceBoundaryCompose, type ToolSequencePort } from "../executors/compose/ToolSequenceBoundary"
import type { ToolDenialPort } from "../executors/compose/ToolTerminalManifestMaterializer"
import type { DialogAwaitingPort, DialogWaiterPort } from "../executors/dialog/DialogCommandExecutor"
import { ProductionDialogAdapter, type ProductionDialogAdapterOptions } from "../executors/dialog/ProductionDialogAdapter"
import {
    ProductionApprovalPolicyAdapter,
    type ProductionApprovalPolicyAdapterOptions,
} from "../executors/policy/ProductionApprovalPolicyAdapter"
import { ProductionProviderAdapter, type ProductionProviderService } from "../executors/provider/ProductionProviderAdapter"
import type {
    ProviderFailureReportPort,
    ProviderRequestLifecyclePort,
    ProviderRoundCheckpointPort,
    ProviderTextPresentationPort,
} from "../executors/provider/ProviderCommandExecutor"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import type { ProviderRequestReportPort } from "../executors/provider/service/ProviderRequestReport"
import {
    createProductionToolAdapter,
    type ProductionToolAdapterOptions,
    type ProductionToolExecutionService,
} from "../executors/tool/ProductionToolAdapter"
import { InMemoryToolApprovalFeedbackLedger, type ToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
import type { OwnedToolResources } from "../executors/tool/ToolDomainResources"
import type { ToolDomainSurface } from "../executors/tool/ToolDomainSurface"
import type { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import type { PostCommitPublisher } from "../new-task/successor-handoff"
import type { RuntimeDiagnosticSink, TaskRuntime } from "../runtime"
import { Task } from "../shell/Task"
import type { TaskExecutorAssembly } from "../shell/TaskExecutorAssembly"
import type { TaskCheckpointRestoreSuspensionPort } from "../shell/TaskShell"
import { type OpenTaskShellOptions, openTaskShell } from "../shell/TaskShellFactory"
import type { TaskPayloadStore, TaskViewPort } from "../stores"

export interface TaskCompositionServices {
    readonly provider: ProductionProviderService
    readonly tool: ProductionToolExecutionService
    readonly toolResources: OwnedToolResources
    readonly toolOperationCancellation?: ProductionToolAdapterOptions["operationCancellation"]
    readonly toolSurface: ToolDomainSurface
    /** Task-scoped WS-072 scheduler; owned by the task so limit changes reach the active turn. */
    readonly toolScheduler: TurnToolScheduler
    readonly compaction: ProductionCompactionService
    readonly readApprovalPolicy: ProductionApprovalPolicyAdapterOptions["readSnapshot"]
    /** Renders the per-round environment block; absent in headless assemblies. */
    readonly environment?: ComposeEnvironmentPort
    /** Explains a round the kernel opened; absent in headless assemblies. */
    readonly continuation?: ComposeContinuationPort
}

export interface TaskCompositionOptions {
    readonly taskId: string
    readonly openReason: OpenTaskShellOptions["openReason"]
    readonly services: TaskCompositionServices
    readonly taskView: TaskViewPort
    readonly diagnostics?: RuntimeDiagnosticSink
    readonly persistence?: OpenTaskShellOptions["persistence"]
    readonly inputPresentation?: OpenTaskShellOptions["inputPresentation"]
    readonly retainedInputPresentation?: RetainedInputPresentationPort
    /** Words a user's refusal the way the refused tool reports it. */
    readonly toolDenial?: ToolDenialPort
    /** Learns when a round carries user input or an unfinished call; see ToolSequencePort. */
    readonly toolSequence?: ToolSequencePort
    readonly deferRestoredCommands?: OpenTaskShellOptions["deferRestoredCommands"]
    /** The chat rows restored dialogs anchor to; see OpenTaskShellOptions. */
    readonly readAnchorRows?: OpenTaskShellOptions["readAnchorRows"]
    /** Condenses the conversation before a round is drafted; see ComposeCompactionBarrierPort. */
    readonly compactionBarrier?: ComposeCompactionBarrierPort
    /** Measures each round's complete request before it is drafted; see ComposeContextWindowGuardPort. */
    readonly contextWindowGuard?: ComposeContextWindowGuardPort
    /** Write the chat row a revealed dialog anchors to; see ProductionDialogAdapter. */
    readonly writeDialogAnchor?: ProductionDialogAdapterOptions["writeAnchor"]
    /** Receivers to fail when a stop makes their answer impossible; see DialogWaiterPort. */
    readonly dialogWaiters?: DialogWaiterPort
    /** Learns when a revealed dialog is durably answerable. */
    readonly dialogAwaiting?: DialogAwaitingPort
    /** Shows the assistant's prose as a chat row; see ProviderTextPresentationPort. */
    readonly providerPresentation?: ProviderTextPresentationPort
    /** Records what each request consumed; see ProviderRequestReportPort. */
    readonly providerRequestReport?: ProviderRequestReportPort
    /** Writes the round's restore point before each request; see ProviderRoundCheckpointPort. */
    readonly providerCheckpoint?: ProviderRoundCheckpointPort
    /** Starts non-request-critical work after provider transport begins. */
    readonly providerLifecycle?: ProviderRequestLifecyclePort
    /** Opens the canonical ReportBug preview after a terminal provider failure. */
    readonly providerFailureReport?: ProviderFailureReportPort
    /** Writes the round's restore point before a compaction rewrites history; see CompactionCheckpointPort. */
    readonly compactionCheckpoint?: CompactionCheckpointPort
    /** Reads the task's model-mistake counter and live user-configured ceiling. */
    readonly readMistakeLimit?: () => { readonly count: number; readonly limit: number }
    /**
     * Shows a finished summary to the user; see CompactionLandingPort.
     *
     * Only the presentation half: condensing the conversation itself is
     * intrinsic to the runtime, so it is not left to the assembly to provide.
     */
    readonly compactionLanding?: CompactionLandingPort
    /** Learns when a compaction run ends; see CompactionSettlementObserverPort. */
    readonly compactionSettlement?: CompactionSettlementObserverPort
    /** Shows a manually requested summary before it lands; see CompactionReviewPort. */
    readonly compactionReview?: CompactionReviewPort
    /** Shows a compaction that failed to produce a summary; see CompactionFailurePresentationPort. */
    readonly compactionFailure?: CompactionFailurePresentationPort
    /** The progress card a run shows; see CompactionProgressCardPort. */
    readonly compactionProgress?: CompactionProgressCardPort
    /**
     * The task's in-memory conversation over `persistence`; see JournalConversationView.
     *
     * An assembly that also builds provider requests passes the view they read,
     * so what a compaction condenses is exactly what the next request sends.
     * Absent, one is built over the journal the shell opens.
     */
    readonly conversationView?: JournalConversationView
    /** Task-scoped approval outcome/feedback ledger shared with the handler owner. */
    readonly approvalFeedback?: ToolApprovalFeedbackLedger
    /**
     * Carries out what a tool result commits the task to, such as the handoff
     * of a `new_task` block; see PostCommitPublisher.
     *
     * Shared with the restored-dialog continuation so a live and a restored
     * answer go through one publisher. Absent, a handoff is dropped and the
     * source keeps working, which is only right for assemblies that cannot
     * start tasks, such as headless subagents.
     */
    readonly postCommit?: PostCommitPublisher
}

export interface TaskCompositionResult {
    readonly task: Task
    readonly checkpointRestore: TaskCheckpointRestoreSuspensionPort
    readonly runtime: TaskRuntime
    readonly assembly: TaskExecutorAssembly
    readonly payloads: TaskPayloadStore
    /** Where an approval response records the feedback its tool block must carry. */
    readonly approvalFeedback: ToolApprovalFeedbackLedger
    /** The conversation a compaction summarizes: what the provider is actually sent. */
    readonly conversation: CompactionConversationPort
    /** Shrinks that same conversation when the provider refuses a request as too long. */
    readonly contextTruncation: ContextTruncationPort
}

/** Let an observer see the run end without making compaction depend on one. */
function instrumentCompaction(port: CompactionPort, observer: CompactionSettlementObserverPort | undefined): CompactionPort {
    return observer ? observer.instrument(port) : port
}

/** Interrupt the tool sequence on rounds that carry user input or an unfinished call. */
function bindToolSequence(port: ProductionComposeAdapter, sequence: ToolSequencePort | undefined): ComposePort {
    return sequence ? new ToolSequenceBoundaryCompose(port, sequence) : port
}

export async function composeTask(options: TaskCompositionOptions): Promise<TaskCompositionResult> {
    let runtime: TaskRuntime | undefined
    let conversation: JournalCompactionConversation | undefined
    const approvalFeedback = options.approvalFeedback ?? new InMemoryToolApprovalFeedbackLedger()
    const opened = await openTaskShell({
        ...options,
        execution: ({ initialState, persistence }) => {
            const readState = () => runtime?.getState() ?? initialState
            // The journal is what provider requests are materialized from, so it is
            // both what a compaction has to read and what it has to shrink. Landing
            // anywhere else leaves the next request exactly as large as before.
            const conversationView =
                options.conversationView ??
                new JournalConversationView(
                    persistence.ports.journal,
                    new ProviderJournalMessageMaterializer(persistence.payloads),
                )
            conversation = new JournalCompactionConversation(persistence.ports.journal, persistence.payloads, conversationView)
            return {
                provider: {
                    execution: new ProductionProviderAdapter({
                        payloads: persistence.payloads,
                        service: options.services.provider,
                    }),
                    presentation: options.providerPresentation,
                    report: options.providerRequestReport,
                    checkpoint: options.providerCheckpoint,
                    lifecycle: options.providerLifecycle,
                    failureReport: options.providerFailureReport,
                },
                compose: bindToolSequence(
                    new ProductionComposeAdapter({
                        payloads: persistence.payloads,
                        journal: persistence.ports.journal,
                        readState,
                        environment: options.services.environment,
                        continuation: options.services.continuation,
                        compactionBarrier: options.compactionBarrier,
                        contextWindowGuard: options.contextWindowGuard,
                        retainedInputPresentation: options.retainedInputPresentation,
                        conversation: conversationView,
                        toolDenial: options.toolDenial,
                    }),
                    options.toolSequence,
                ),
                compaction: instrumentCompaction(
                    new ProductionCompactionAdapter({
                        payloads: persistence.payloads,
                        service: options.services.compaction,
                        truncation: conversation,
                        canonicalLanding: conversation,
                        landing: options.compactionLanding,
                        review: options.compactionReview,
                        failure: options.compactionFailure,
                        progress: options.compactionProgress,
                        checkpoint: options.compactionCheckpoint,
                    }),
                    options.compactionSettlement,
                ),
                dialog: {
                    execution: new ProductionDialogAdapter({
                        taskId: options.taskId,
                        journal: persistence.ports.journal,
                        payloads: persistence.payloads,
                        taskView: options.taskView,
                        readState,
                        writeAnchor: options.writeDialogAnchor,
                    }),
                    waiters: options.dialogWaiters,
                    awaiting: options.dialogAwaiting,
                },
                policy: new ProductionApprovalPolicyAdapter({ readSnapshot: options.services.readApprovalPolicy }),
                tool: createProductionToolAdapter({
                    payloads: persistence.payloads,
                    journal: persistence.ports.journal,
                    approvalFeedback,
                    resources: options.services.toolResources,
                    operationCancellation: options.services.toolOperationCancellation,
                    surface: options.services.toolSurface,
                    service: options.services.tool,
                    scheduler: options.services.toolScheduler,
                    readMistakeLimit: options.readMistakeLimit,
                    publishPostCommit: options.postCommit,
                }),
            }
        },
    })
    runtime = opened.runtime
    if (!conversation) throw new Error("TaskCompositionMissingConversation")
    return {
        task: new Task(options.taskId, {
            shell: opened.shell,
            runtime: opened.runtime,
            payloads: opened.payloads,
        }),
        checkpointRestore: opened.checkpointRestore,
        runtime: opened.runtime,
        assembly: opened.assembly,
        payloads: opened.payloads,
        approvalFeedback,
        conversation,
        contextTruncation: conversation,
    }
}
