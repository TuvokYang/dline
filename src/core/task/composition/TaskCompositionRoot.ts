import {
	ProductionCompactionAdapter,
	type ProductionCompactionService,
} from "../executors/compaction/ProductionCompactionAdapter"
import { type ComposeEnvironmentPort, ProductionComposeAdapter } from "../executors/compose/ProductionComposeAdapter"
import { ProductionDialogAdapter } from "../executors/dialog/ProductionDialogAdapter"
import {
	ProductionApprovalPolicyAdapter,
	type ProductionApprovalPolicyAdapterOptions,
} from "../executors/policy/ProductionApprovalPolicyAdapter"
import { ProductionProviderAdapter, type ProductionProviderService } from "../executors/provider/ProductionProviderAdapter"
import { ProductionSpawnAdapter, type SpawnChildLauncher } from "../executors/spawn/ProductionSpawnAdapter"
import { createProductionToolAdapter, type ProductionToolExecutionService } from "../executors/tool/ProductionToolAdapter"
import type { OwnedToolResources } from "../executors/tool/ToolDomainResources"
import type { ToolDomainSurface } from "../executors/tool/ToolDomainSurface"
import type { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import type { RuntimeDiagnosticSink, TaskRuntime } from "../runtime"
import { Task } from "../shell/Task"
import type { TaskExecutorAssembly } from "../shell/TaskExecutorAssembly"
import { type OpenTaskShellOptions, openTaskShell } from "../shell/TaskShellFactory"
import type { TaskPayloadStore, TaskViewPort } from "../stores"

export interface TaskCompositionServices {
	readonly provider: ProductionProviderService
	readonly tool: ProductionToolExecutionService
	readonly toolResources: OwnedToolResources
	readonly toolSurface: ToolDomainSurface
	/** Task-scoped WS-072 scheduler; owned by the task so limit changes reach the active turn. */
	readonly toolScheduler: TurnToolScheduler
	readonly compaction: ProductionCompactionService
	readonly readApprovalPolicy: ProductionApprovalPolicyAdapterOptions["readSnapshot"]
	readonly spawn: SpawnChildLauncher
	/** Renders the per-round environment block; absent in headless assemblies. */
	readonly environment?: ComposeEnvironmentPort
}

export interface TaskCompositionOptions {
	readonly taskId: string
	readonly openReason: OpenTaskShellOptions["openReason"]
	readonly services: TaskCompositionServices
	readonly taskView: TaskViewPort
	readonly diagnostics?: RuntimeDiagnosticSink
	readonly persistence?: OpenTaskShellOptions["persistence"]
	readonly inputPresentation?: OpenTaskShellOptions["inputPresentation"]
}

export type TaskCompositionResult =
	| {
			readonly kind: "ready"
			readonly task: Task
			readonly runtime: TaskRuntime
			readonly assembly: TaskExecutorAssembly
			readonly payloads: TaskPayloadStore
	  }
	| { readonly kind: "read_only"; readonly reason: string; readonly diagnostics: readonly { code: string; message: string }[] }

export async function composeTask(options: TaskCompositionOptions): Promise<TaskCompositionResult> {
	let runtime: TaskRuntime | undefined
	const opened = await openTaskShell({
		...options,
		execution: ({ initialState, persistence }) => {
			const readState = () => runtime?.getState() ?? initialState
			return {
				provider: new ProductionProviderAdapter({ payloads: persistence.payloads, service: options.services.provider }),
				compose: new ProductionComposeAdapter({
					payloads: persistence.payloads,
					journal: persistence.ports.journal,
					readState,
					environment: options.services.environment,
				}),
				compaction: new ProductionCompactionAdapter({
					payloads: persistence.payloads,
					service: options.services.compaction,
				}),
				dialog: new ProductionDialogAdapter({
					taskId: options.taskId,
					journal: persistence.ports.journal,
					taskView: options.taskView,
					readState,
				}),
				policy: new ProductionApprovalPolicyAdapter({ readSnapshot: options.services.readApprovalPolicy }),
				tool: createProductionToolAdapter({
					payloads: persistence.payloads,
					journal: persistence.ports.journal,
					resources: options.services.toolResources,
					surface: options.services.toolSurface,
					service: options.services.tool,
					scheduler: options.services.toolScheduler,
				}),
				spawn: new ProductionSpawnAdapter({ payloads: persistence.payloads, launcher: options.services.spawn }),
			}
		},
	})
	if (opened.kind === "read_only") return opened
	runtime = opened.runtime
	return {
		kind: "ready",
		task: new Task(options.taskId, {
			shell: opened.shell,
			runtime: opened.runtime,
			payloads: opened.payloads,
		}),
		runtime: opened.runtime,
		assembly: opened.assembly,
		payloads: opened.payloads,
	}
}
