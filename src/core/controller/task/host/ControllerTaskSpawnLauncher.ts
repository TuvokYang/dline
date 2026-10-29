import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import type { PeerTaskSpawnPort } from "@core/task/executors/spawn/PeerTaskSpawnPort"
import type { ClineExtensionContext } from "@shared/cline/context"

export interface ControllerTaskSpawnLauncherOptions {
    readonly context: ClineExtensionContext
    readonly parentTaskId: string
}

/** Starts an admitted peer task owned by the host orchestrator. */
export class ControllerTaskSpawnLauncher implements PeerTaskSpawnPort {
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
            // initTask returning is the admission boundary: the peer task is already
            // registered and running, so a later source cancellation must not roll it back.
            admitted = true
            return { childTaskId }
        } finally {
            if (!admitted) await panel.dispose().catch(() => undefined)
        }
    }
}
