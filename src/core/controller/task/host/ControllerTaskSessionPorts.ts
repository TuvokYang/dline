import { refreshClineRulesToggles } from "@core/context/instructions/user-instructions/agent-rules"
import { refreshExternalRulesToggles } from "@core/context/instructions/user-instructions/external-rules"
import type { Controller } from "@core/controller"
import { inputSemanticCatalogService } from "@core/controller/slash/input-semantic-catalog"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import { buildActiveTasksSection } from "@core/task/active-tasks/ActiveTaskContextProvider"
import type { TaskSessionPorts } from "@core/task/composition/TaskSessionPorts"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { HostProvider } from "@/hosts/host-provider"
import { remoteUsageSettlement } from "@/services/telemetry/remote/remoteUsageRuntime"
import { sendPartialMessageEvent } from "../../ui/subscribeToPartialMessage"
import type { TaskOpening } from "../opened-task"

/**
 * Adapts Controller and IDE services to the narrow ports owned by one task session.
 *
 * One instance serves exactly one opening: every row it presents is attributed
 * to that opening so the Webview never merges it into another one.
 */
export class ControllerTaskSessionPorts implements TaskSessionPorts {
    readonly collaboration: TaskSessionPorts["collaboration"]
    readonly promptContext: TaskSessionPorts["promptContext"]
    readonly environment: TaskSessionPorts["environment"]
    readonly presentation: TaskSessionPorts["presentation"]
    readonly semanticCatalog: TaskSessionPorts["semanticCatalog"]
    readonly successor: TaskSessionPorts["successor"]
    readonly profileUsage: TaskSessionPorts["profileUsage"]
    /** Process-wide remote usage reporting; it records nothing while reporting is not allowed. */
    readonly usageSettlement: TaskSessionPorts["usageSettlement"] = remoteUsageSettlement

    constructor(
        private readonly controller: Controller,
        opening: TaskOpening,
    ) {
        const semanticCatalog = inputSemanticCatalogService(controller)
        this.collaboration = OrchestratorController.getInstance().collaboration
        this.promptContext = {
            getHostVersion: () => HostProvider.env.getHostVersion({}),
            refreshClineRules: (cwd) => refreshClineRulesToggles(controller, cwd),
            refreshExternalRules: (cwd) => refreshExternalRulesToggles(controller, cwd),
            getMcpServers: () => controller.getMcpServersForOwner(),
            getTaskMcpServers: () => controller.mcpHub.getServersForOwner(controller.mcpOwnerId),
        }
        this.environment = {
            getHostVersion: () => HostProvider.env.getHostVersion({}),
            getVisibleFiles: async () => (await HostProvider.window.getVisibleTabs({})).paths,
            getOpenTabs: async () => (await HostProvider.window.getOpenTabs({})).paths,
            buildActiveTasksSection: ({ currentCwd, excludeTaskId }) =>
                buildActiveTasksSection({
                    controllers: OrchestratorController.getInstance().getActiveControllers(),
                    currentCwd,
                    excludeTaskId,
                }),
            activeTaskCount: () => OrchestratorController.getInstance().getControllerCount(),
        }
        this.presentation = {
            publish: (row) => sendPartialMessageEvent(controller, convertClineMessageToProto(row), opening),
        }
        this.semanticCatalog = {
            current: () => semanticCatalog.current(),
            discovered: () => semanticCatalog.discovered(),
            conflicts: () => semanticCatalog.conflicts(),
        }
        this.successor = {
            start: async (sourceTaskId, handoff) => {
                if (sourceTaskId !== opening.taskId) return
                await controller.startSuccessorTask(opening, handoff)
            },
        }
        this.profileUsage = {
            record: (profileId, increment) => controller.recordProfileTokenUsage(profileId, increment),
        }
    }
}
