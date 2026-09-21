import { randomUUID } from "node:crypto"
import type { Controller } from "@core/controller"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import type { SpawnChildLauncher, SpawnChildReservation } from "@core/task/executors/spawn/ProductionSpawnAdapter"
import type { ClineExtensionContext } from "@shared/cline/context"

export interface ControllerTaskSpawnLauncherOptions {
	readonly context: ClineExtensionContext
	readonly parent: Controller
	readonly parentTaskId: string
}

/** Creates a provisional panel and admits it only after SpawnCoordinator owns the lease. */
export class ControllerTaskSpawnLauncher implements SpawnChildLauncher {
	constructor(private readonly options: ControllerTaskSpawnLauncherOptions) {}

	async reserve(input: Parameters<SpawnChildLauncher["reserve"]>[0]): Promise<SpawnChildReservation> {
		if (input.signal.aborted) throw input.signal.reason
		const childTaskId = randomUUID()
		const { VscodeWebviewPanelProvider } = await import("@/hosts/vscode/VscodeWebviewPanelProvider")
		const panel = new VscodeWebviewPanelProvider(this.options.context, { deferController: false })
		const title = input.handoff.context.trim().slice(0, 16) || "Spawned Task"
		await panel.createPanel(title)
		let admitted = false
		let disposed = false
		return {
			childTaskId,
			admit: async (signal) => {
				if (signal.aborted) throw signal.reason
				if (disposed) throw new Error("Spawn reservation was disposed")
				if (admitted) return
				const orchestrator = OrchestratorController.getInstance()
				await panel.controller.initTask(
					input.handoff.context,
					undefined,
					undefined,
					undefined,
					input.handoff.taskSettings,
					{
						taskId: childTaskId,
						initialUserContent: [...input.handoff.initialUserContent] as never,
						startInBackground: true,
						beforeStart: () => orchestrator.recordSpawn(this.options.parentTaskId, childTaskId),
					},
				)
				admitted = true
			},
			dispose: async () => {
				if (disposed || admitted) return
				disposed = true
				await panel.dispose()
			},
		}
	}
}
