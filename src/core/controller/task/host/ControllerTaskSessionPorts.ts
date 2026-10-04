import { refreshClineRulesToggles } from "@core/context/instructions/user-instructions/agent-rules"
import { refreshExternalRulesToggles } from "@core/context/instructions/user-instructions/external-rules"
import { refreshWorkflowToggles } from "@core/context/instructions/user-instructions/workflows"
import type { Controller } from "@core/controller"
import { refreshSkills } from "@core/controller/file/refreshSkills"
import { refreshSubagents } from "@core/controller/file/refreshSubagents"
import { inputSemanticCatalogService } from "@core/controller/slash/input-semantic-catalog"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import { buildActiveTasksSection } from "@core/task/active-tasks/ActiveTaskContextProvider"
import type { TaskSessionPorts } from "@core/task/composition/TaskSessionPorts"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { HostProvider } from "@/hosts/host-provider"
import { sendPartialMessageEvent } from "../../ui/subscribeToPartialMessage"

/** Adapts Controller and IDE services to the narrow ports owned by one task session. */
export class ControllerTaskSessionPorts implements TaskSessionPorts {
	readonly collaboration: TaskSessionPorts["collaboration"]
	readonly promptContext: TaskSessionPorts["promptContext"]
	readonly environment: TaskSessionPorts["environment"]
	readonly presentation: TaskSessionPorts["presentation"]
	readonly semanticCatalog: TaskSessionPorts["semanticCatalog"]
	readonly successor: TaskSessionPorts["successor"]
	readonly profileUsage: TaskSessionPorts["profileUsage"]

	constructor(private readonly controller: Controller) {
		const semanticCatalog = inputSemanticCatalogService(controller)
		this.collaboration = OrchestratorController.getInstance().collaboration
		this.promptContext = {
			getHostVersion: () => HostProvider.env.getHostVersion({}),
			refreshClineRules: (cwd) => refreshClineRulesToggles(controller, cwd),
			refreshExternalRules: (cwd) => refreshExternalRulesToggles(controller, cwd),
			refreshWorkflows: (cwd) => refreshWorkflowToggles(controller, cwd),
			refreshSkills: () => refreshSkills(controller),
			refreshSubagents: () => refreshSubagents(controller),
			getMcpServers: () => controller.getMcpServersForOwner(),
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
		}
		this.presentation = {
			publish: (row) => sendPartialMessageEvent(controller, convertClineMessageToProto(row)),
		}
		this.semanticCatalog = {
			current: () => semanticCatalog.current(),
			discovered: () => semanticCatalog.discovered(),
		}
		this.successor = {
			start: async (sourceTaskId, handoff) => {
				await controller.startSuccessorTask(
					sourceTaskId,
					handoff.context,
					handoff.taskSettings,
					handoff.initialUserContent,
				)
			},
		}
		this.profileUsage = {
			record: (profileId, increment) => controller.recordProfileTokenUsage(profileId, increment),
		}
	}
}
