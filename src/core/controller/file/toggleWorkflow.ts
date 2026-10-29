import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { setCapabilityEnabled } from "@core/storage/settings/capability-toggle-store"
import { setGlobalCapabilityEnabled } from "@core/storage/settings/global-capability-settings"
import { ClineRulesToggles, RuleScope, ToggleWorkflowRequest } from "@shared/proto/dline/file"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { capabilityWriteContext } from "./capability-write-context"

/**
 * Toggles a workflow on or off
 * @param controller The controller instance
 * @param request The request containing the workflow path and enabled state
 * @returns The updated workflow toggles
 */
export async function toggleWorkflow(controller: Controller, request: ToggleWorkflowRequest): Promise<ClineRulesToggles> {
    const { workflowPath, enabled, scope } = request

    if (!workflowPath || typeof enabled !== "boolean" || scope === undefined) {
        Logger.error("toggleWorkflow: Missing or invalid parameters", {
            workflowPath,
            scope,
            enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
        })
        throw new Error("Missing or invalid parameters for toggleWorkflow")
    }

    // Handle the three different scopes
    let toggles: Record<string, boolean>

    switch (scope) {
        case RuleScope.GLOBAL: {
            toggles = await setGlobalCapabilityEnabled(controller.stateManager, "globalWorkflowToggles", workflowPath, enabled)
            break
        }
        case RuleScope.LOCAL: {
            // Local origin, but the preference lands in the scope the editor is in.
            toggles = (await setCapabilityEnabled(
                controller.stateManager,
                "workflows",
                capabilityWriteContext(controller),
                capabilityResourceId(workflowPath),
                enabled,
            )) as Record<string, boolean>
            break
        }
        case RuleScope.REMOTE: {
            toggles = controller.stateManager.getGlobalStateKey("remoteWorkflowToggles")
            toggles[workflowPath] = enabled
            controller.stateManager.setGlobalState("remoteWorkflowToggles", toggles)
            break
        }
        default:
            throw new Error(`Invalid scope: ${scope}`)
    }

    // The response below already carries the updated toggles, so a full state
    // publication would only add a webview-wide recompute to a switch.
    return ClineRulesToggles.create({ toggles: toggles })
}
