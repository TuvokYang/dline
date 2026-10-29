import { PromptProfile } from "../profiles/types"
import { ProfileToolSet } from "./profile-tool-set"
import { LITE_TOOL_IDS, STANDARD_TOOL_IDS } from "./tool-ids"
import { STANDARD_TOOL_SPECS } from "./tool-specs"

export { LITE_TOOL_IDS, STANDARD_TOOL_IDS } from "./tool-ids"

/** Creates a fully registered exact-profile tool set. */
export function createToolSet(): ProfileToolSet {
    const tools = new ProfileToolSet()
    const standardSpecs = new Map(STANDARD_TOOL_SPECS.map((spec) => [spec.id, spec]))
    for (const id of STANDARD_TOOL_IDS) {
        const base = standardSpecs.get(id)
        if (!base) {
            throw new Error(`Missing canonical Standard tool spec: ${id}`)
        }
        tools.register({ ...base, profile: PromptProfile.Standard })
    }
    for (const id of LITE_TOOL_IDS) {
        const base = standardSpecs.get(id)
        if (!base) {
            throw new Error(`Missing canonical Lite tool spec source: ${id}`)
        }
        tools.register({ ...base, profile: PromptProfile.Lite })
    }
    return tools
}
