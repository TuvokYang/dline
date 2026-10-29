import { refreshClineRulesToggles } from "@core/context/instructions/user-instructions/agent-rules"
import { refreshExternalRulesToggles } from "@core/context/instructions/user-instructions/external-rules"
import { refreshWorkflowToggles } from "@core/context/instructions/user-instructions/workflows"
import { EmptyRequest } from "@shared/proto/dline/common"
import { RefreshedDlineToggles } from "@shared/proto/dline/file"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import type { Controller } from "../index"
import { rememberDiscoveredToggles } from "./capability-discovery-cache"
import { coalesceCapabilityScan } from "./refresh-coalescing"
import { refreshSkills } from "./refreshSkills"

/**
 * Refreshes all dline toggles (Cline rules, external rules, workflows, and skills)
 *
 * The capability panel polls this on a short timer while task startup and state
 * publishes trigger it again, so concurrent callers share one in-flight scan
 * instead of each walking the workspace.
 *
 * @param controller The controller instance
 * @param _request The empty request
 * @returns RefreshedDlineToggles containing updated toggles for all types
 */
export function refreshRules(controller: Controller, _request: EmptyRequest): Promise<RefreshedDlineToggles> {
    return coalesceCapabilityScan(controller, "rules", () => scanRules(controller))
}

async function scanRules(controller: Controller): Promise<RefreshedDlineToggles> {
    const startedAt = performance.now()
    try {
        const cwd = await getCwd(getDesktopDir())
        const cwdMs = Math.round(performance.now() - startedAt)
        let stageStartedAt = performance.now()
        const rulesRefresh = await refreshClineRulesToggles(controller, cwd)
        const { globalToggles, localToggles } = rulesRefresh
        const dlineRulesMs = Math.round(performance.now() - stageStartedAt)
        stageStartedAt = performance.now()
        const externalRefresh = await refreshExternalRulesToggles(controller, cwd)
        const { cursorLocalToggles, windsurfLocalToggles, agentsLocalToggles } = externalRefresh
        const externalRulesMs = Math.round(performance.now() - stageStartedAt)
        stageStartedAt = performance.now()
        const workflowsRefresh = await refreshWorkflowToggles(controller, cwd)
        const { localWorkflowToggles, globalWorkflowToggles } = workflowsRefresh
        const workflowsMs = Math.round(performance.now() - stageStartedAt)
        stageStartedAt = performance.now()
        const { globalSkills, localSkills } = await refreshSkills(controller)
        const skillsMs = Math.round(performance.now() - stageStartedAt)

        // The state push needs to know which resources exist. Discovery no longer
        // writes its result into the preference store, so remember the raw scan
        // here instead — the resolved maps above already fold in user overrides
        // and cannot answer that question.
        rememberDiscoveredToggles(controller, "rules", rulesRefresh.discoveredLocalToggles, rulesRefresh.localScanComplete)
        rememberDiscoveredToggles(
            controller,
            "cursorRules",
            externalRefresh.discovered.cursorRules.toggles,
            externalRefresh.discovered.cursorRules.complete,
        )
        rememberDiscoveredToggles(
            controller,
            "windsurfRules",
            externalRefresh.discovered.windsurfRules.toggles,
            externalRefresh.discovered.windsurfRules.complete,
        )
        rememberDiscoveredToggles(
            controller,
            "agentsRules",
            externalRefresh.discovered.agentsRules.toggles,
            externalRefresh.discovered.agentsRules.complete,
        )
        rememberDiscoveredToggles(
            controller,
            "workflows",
            workflowsRefresh.discoveredLocalToggles,
            workflowsRefresh.localScanComplete,
        )
        recordPerfPhase(
            PerfDomain.Capability,
            "rules_refresh_rpc",
            performance.now() - startedAt,
            {
                cwdMs,
                dlineRulesMs,
                externalRulesMs,
                workflowsMs,
                skillsMs,
                dlineRules: Object.keys(globalToggles).length + Object.keys(localToggles).length,
                externalRules:
                    Object.keys(cursorLocalToggles).length +
                    Object.keys(windsurfLocalToggles).length +
                    Object.keys(agentsLocalToggles).length,
                workflows: Object.keys(localWorkflowToggles).length + Object.keys(globalWorkflowToggles).length,
                skills: globalSkills.length + localSkills.length,
            },
            { taskId: controller.task?.taskId },
        )
        if (Logger.isDebugEnabled()) {
            Logger.debug(
                `[CapabilityPerf] phase=rules_refresh_rpc taskId=${controller.task?.taskId ?? "none"} cwdMs=${cwdMs} dlineRulesMs=${dlineRulesMs} externalRulesMs=${externalRulesMs} workflowsMs=${workflowsMs} skillsMs=${skillsMs} totalMs=${Math.round(performance.now() - startedAt)} dlineRules=${Object.keys(globalToggles).length + Object.keys(localToggles).length} externalRules=${Object.keys(cursorLocalToggles).length + Object.keys(windsurfLocalToggles).length + Object.keys(agentsLocalToggles).length} workflows=${Object.keys(localWorkflowToggles).length + Object.keys(globalWorkflowToggles).length} skills=${globalSkills.length + localSkills.length}`,
            )
        }

        return RefreshedDlineToggles.create({
            globalClineRulesToggles: { toggles: globalToggles },
            localClineRulesToggles: { toggles: localToggles },
            localCursorRulesToggles: { toggles: cursorLocalToggles },
            localWindsurfRulesToggles: { toggles: windsurfLocalToggles },
            localAgentsRulesToggles: { toggles: agentsLocalToggles },
            localWorkflowToggles: { toggles: localWorkflowToggles },
            globalWorkflowToggles: { toggles: globalWorkflowToggles },
            localSkillsToggles: { toggles: buildSkillToggles(localSkills) },
            globalSkillsToggles: { toggles: buildSkillToggles(globalSkills) },
        })
    } catch (error) {
        Logger.error("Failed to refresh rules:", error)
        recordPerfPhase(PerfDomain.Capability, "rules_refresh_rpc_error", performance.now() - startedAt, undefined, {
            taskId: controller.task?.taskId,
        })
        if (Logger.isDebugEnabled()) {
            Logger.debug(
                `[CapabilityPerf] phase=rules_refresh_rpc_error taskId=${controller.task?.taskId ?? "none"} totalMs=${Math.round(performance.now() - startedAt)}`,
            )
        }
        throw error
    }
}

/**
 * Build a ClineRulesToggles map from SkillInfo array.
 * Maps skill name → enabled state (name from frontmatter, not file path).
 */
function buildSkillToggles(skills: { name: string; path: string; enabled: boolean }[]): Record<string, boolean> {
    const toggles: Record<string, boolean> = {}
    for (const skill of skills) {
        if (!skill.path.startsWith("remote:")) toggles[skill.path] = skill.enabled
    }
    return toggles
}
