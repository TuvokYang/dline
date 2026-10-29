import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ServerTool } from "@shared/proto/dline/models/metadata"

/**
 * Server tool availability is the intersection of two independently owned facts:
 *
 * - the model registry declares which hosted tools a model can run, and
 * - the profile records which of those the user switched off.
 *
 * Keeping the switch in its own list is what lets an empty list keep its natural
 * meaning ("nothing is turned off"). Storing the switch back into the declaration
 * would make "off" indistinguishable from "this model has no such capability",
 * which is how a hosted-capable model silently loses its hosted route.
 */

/** Read the hosted tools a model declares, dropping unspecified entries. */
export function declaredServerTools(capabilities: Pick<ModelCapabilities, "tools"> | undefined): readonly ServerTool[] {
    const declared = capabilities?.tools ?? []
    return declared.filter((tool): tool is ServerTool => tool !== ServerTool.SERVER_TOOL_UNSPECIFIED)
}

/** Report whether the profile leaves one declared hosted tool enabled. */
export function isServerToolEnabled(tool: ServerTool, disabledServerTools: readonly ServerTool[] | undefined): boolean {
    return disabledServerTools?.includes(tool) !== true
}

/** Add or remove one tool from the disabled list, preserving unrelated switches. */
export function withServerToolSwitch(
    disabledServerTools: readonly ServerTool[] | undefined,
    tool: ServerTool,
    enabled: boolean,
): ServerTool[] {
    const current = disabledServerTools ?? []
    if (enabled) {
        return current.filter((candidate) => candidate !== tool)
    }
    return current.includes(tool) ? [...current] : [...current, tool]
}

/** Resolve the hosted tools that are both declared by the model and left on by the user. */
export function enabledServerTools(
    capabilities: Pick<ModelCapabilities, "tools"> | undefined,
    disabledServerTools: readonly ServerTool[] | undefined,
): readonly ServerTool[] {
    return declaredServerTools(capabilities).filter((tool) => isServerToolEnabled(tool, disabledServerTools))
}
