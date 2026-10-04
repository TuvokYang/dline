import { randomUUID } from "node:crypto"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import type { PeerTaskSpawnPort } from "@core/task/executors/spawn/PeerTaskSpawnPort"
import type { SpawnChildLauncher, SpawnChildReservation } from "@core/task/executors/spawn/ProductionSpawnAdapter"
import type { ClineExtensionContext } from "@shared/cline/context"

export interface ControllerTaskSpawnLauncherOptions {
	readonly context: ClineExtensionContext
	readonly parentTaskId: string
}

/** Creates a provisional panel and admits it only after SpawnCoordinator owns the lease. */
export class ControllerTaskSpawnLauncher implements SpawnChildLauncher, PeerTaskSpawnPort {
	constructor(private readonly options: ControllerTaskSpawnLauncherOptions) {}

	async spawn(input: Parameters<PeerTaskSpawnPort["spawn"]>[0]): Promise<{ readonly childTaskId: string }> {
		if (input.signal.aborted) throw input.signal.reason
		const { VscodeWebviewPanelProvider } = await import("@/hosts/vscode/VscodeWebviewPanelProvider")
		if (input.signal.aborted) throw input.signal.reason
		const panel = new VscodeWebviewPanelProvider(this.options.context, { deferController: false })
		let admitted = false
		try {
			const title = input.task.length > 16 ? input.task.substring(0, 16) : input.task
			await panel.createPanel(title)
			if (input.signal.aborted) throw input.signal.reason
			const childTaskId = await panel.controller.initTask(
				input.task,
				undefined,
				undefined,
				undefined,
				{ planModeProfile: input.profile, actModeProfile: input.profile, mode: input.mode },
				{
					...(input.context ? { context: [input.context] } : {}),
					taskKind: "spawned",
					startInBackground: true,
					beforeStart: (initializedChildTaskId) =>
						OrchestratorController.getInstance().recordSpawn(this.options.parentTaskId, initializedChildTaskId),
				},
			)
			if (input.signal.aborted) throw input.signal.reason
			admitted = true
			return { childTaskId }
		} finally {
			if (!admitted) await panel.dispose().catch(() => undefined)
		}
	}

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
						taskKind: "spawned",
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
