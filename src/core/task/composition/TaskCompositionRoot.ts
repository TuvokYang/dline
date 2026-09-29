import type { CompactionSettlementObserverPort } from "../compaction/CompactionRoundBarrier"
import { type CompactionLandingPort, CompositeCompactionLanding } from "../compaction/CompactionSummaryLanding"
import { type CompactionConversationPort, JournalCompactionConversation } from "../compaction/JournalCompactionConversation"
import type { CompactionPort } from "../executors/compaction/CompactionCommandExecutor"
import type { CompactionFailurePresentationPort, CompactionReviewPort } from "../executors/compaction/ProductionCompactionAdapter"
import {
	ProductionCompactionAdapter,
	type ProductionCompactionService,
} from "../executors/compaction/ProductionCompactionAdapter"
import type { ComposeBackgroundResultsPort } from "../executors/compose/ComposeBackgroundResultsPort"
import {
	type ComposeCompactionBarrierPort,
	type ComposeContinuationPort,
	type ComposeEnvironmentPort,
	ProductionComposeAdapter,
} from "../executors/compose/ProductionComposeAdapter"
import type { DialogWaiterPort } from "../executors/dialog/DialogCommandExecutor"
import { ProductionDialogAdapter, type ProductionDialogAdapterOptions } from "../executors/dialog/ProductionDialogAdapter"
import {
	ProductionApprovalPolicyAdapter,
	type ProductionApprovalPolicyAdapterOptions,
} from "../executors/policy/ProductionApprovalPolicyAdapter"
import { ProductionProviderAdapter, type ProductionProviderService } from "../executors/provider/ProductionProviderAdapter"
import type { ProviderTextPresentationPort } from "../executors/provider/ProviderCommandExecutor"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import type { ProviderRequestReportPort } from "../executors/provider/service/ProviderRequestReport"
import { ProductionSpawnAdapter, type SpawnChildLauncher } from "../executors/spawn/ProductionSpawnAdapter"
import {
	createProductionToolAdapter,
	type ProductionToolAdapterOptions,
	type ProductionToolExecutionService,
} from "../executors/tool/ProductionToolAdapter"
import { InMemoryToolApprovalFeedbackLedger, type ToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
import type { OwnedToolResources } from "../executors/tool/ToolDomainResources"
import type { ToolDomainSurface } from "../executors/tool/ToolDomainSurface"
import type { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import { createSuccessorHandoffPublisher, type TaskSuccessorPort } from "../new-task/successor-handoff"
import type { RuntimeDiagnosticSink, TaskRuntime } from "../runtime"
import { Task } from "../shell/Task"
import type { TaskExecutorAssembly } from "../shell/TaskExecutorAssembly"
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
	readonly spawn: SpawnChildLauncher
	/** Renders the per-round environment block; absent in headless assemblies. */
	readonly environment?: ComposeEnvironmentPort
	/** Explains a round the kernel opened; absent in headless assemblies. */
	readonly continuation?: ComposeContinuationPort
	/** Delivers finished background work; absent when a task runs none. */
	readonly backgroundResults?: ComposeBackgroundResultsPort
}

export interface TaskCompositionOptions {
	readonly taskId: string
	readonly openReason: OpenTaskShellOptions["openReason"]
	readonly services: TaskCompositionServices
	readonly taskView: TaskViewPort
	readonly diagnostics?: RuntimeDiagnosticSink
	readonly persistence?: OpenTaskShellOptions["persistence"]
	readonly inputPresentation?: OpenTaskShellOptions["inputPresentation"]
	readonly deferRestoredCommands?: OpenTaskShellOptions["deferRestoredCommands"]
	/** Condenses the conversation before a round is drafted; see ComposeCompactionBarrierPort. */
	readonly compactionBarrier?: ComposeCompactionBarrierPort
	/** Write the chat row a revealed dialog anchors to; see ProductionDialogAdapter. */
	readonly writeDialogAnchor?: ProductionDialogAdapterOptions["writeAnchor"]
	/** Receivers to fail when a stop makes their answer impossible; see DialogWaiterPort. */
	readonly dialogWaiters?: DialogWaiterPort
	/** Shows the assistant's prose as a chat row; see ProviderTextPresentationPort. */
	readonly providerPresentation?: ProviderTextPresentationPort
	/** Records what each request consumed; see ProviderRequestReportPort. */
	readonly providerRequestReport?: ProviderRequestReportPort
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
	/**
	 * The task's in-memory conversation over `persistence`; see JournalConversationView.
	 *
	 * An assembly that also builds provider requests passes the view they read,
	 * so what a compaction condenses is exactly what the next request sends.
	 * Absent, one is built over the journal the shell opens.
	 */
	readonly conversationView?: JournalConversationView
	/**
	 * Starts the task a `new_task` block hands its work to; see TaskSuccessorPort.
	 *
	 * Absent, a handoff is dropped and the source keeps working, which is only
	 * right for assemblies that cannot start tasks, such as headless subagents.
	 */
	readonly successor?: TaskSuccessorPort
}

export interface TaskCompositionResult {
	readonly task: Task
	readonly runtime: TaskRuntime
	readonly assembly: TaskExecutorAssembly
	readonly payloads: TaskPayloadStore
	/** Where an approval response records the feedback its tool block must carry. */
	readonly approvalFeedback: ToolApprovalFeedbackLedger
	/** The conversation a compaction summarizes: what the provider is actually sent. */
	readonly conversation: CompactionConversationPort
}

/** Let an observer see the run end without making compaction depend on one. */
function instrumentCompaction(port: CompactionPort, observer: CompactionSettlementObserverPort | undefined): CompactionPort {
	return observer ? observer.instrument(port) : port
}

export async function composeTask(options: TaskCompositionOptions): Promise<TaskCompositionResult> {
	let runtime: TaskRuntime | undefined
	let conversation: JournalCompactionConversation | undefined
	const approvalFeedback = new InMemoryToolApprovalFeedbackLedger()
	const opened = await openTaskShell({
		...options,
		execution: ({ initialState, persistence }) => {
			const readState = () => runtime?.getState() ?? initialState
			// The journal is what provider requests are materialized from, so it is
			// both what a compaction has to read and what it has to shrink. Landing
			// anywhere else leaves the next request exactly as large as before.
			conversation = new JournalCompactionConversation(
				persistence.ports.journal,
				persistence.payloads,
				options.conversationView ??
					new JournalConversationView(
						persistence.ports.journal,
						new ProviderJournalMessageMaterializer(persistence.payloads),
					),
			)
			return {
				provider: {
					execution: new ProductionProviderAdapter({
						payloads: persistence.payloads,
						service: options.services.provider,
					}),
					presentation: options.providerPresentation,
					report: options.providerRequestReport,
				},
				compose: new ProductionComposeAdapter({
					payloads: persistence.payloads,
					journal: persistence.ports.journal,
					readState,
					environment: options.services.environment,
					continuation: options.services.continuation,
					backgroundResults: options.services.backgroundResults,
					compactionBarrier: options.compactionBarrier,
				}),
				compaction: instrumentCompaction(
					new ProductionCompactionAdapter({
						payloads: persistence.payloads,
						service: options.services.compaction,
						landing: new CompositeCompactionLanding([
							conversation,
							...(options.compactionLanding ? [options.compactionLanding] : []),
						]),
						review: options.compactionReview,
						failure: options.compactionFailure,
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
					// The composition root owns the runtime, so it is what marks the
					// source consumed; the host only decides how a successor starts.
					publishPostCommit: options.successor
						? createSuccessorHandoffPublisher({ runtime: () => runtime, successor: options.successor })
						: undefined,
				}),
				spawn: new ProductionSpawnAdapter({ payloads: persistence.payloads, launcher: options.services.spawn }),
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
		runtime: opened.runtime,
		assembly: opened.assembly,
		payloads: opened.payloads,
		approvalFeedback,
		conversation,
	}
}
