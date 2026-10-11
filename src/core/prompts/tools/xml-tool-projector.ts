import type { DlineDefaultTool } from "../../../shared/tools"
import { getPrompt } from "../i18n"
import { assemblePromptFragments } from "../system-prompt/assembly/prompt-fragment-assembler"
import type { SystemPromptContext } from "../system-prompt/context"
import { type ProfileToolParam, type ProfileToolSpec, resolveProfilePromptText } from "./profile-tool-set"

/** Filters parameters using the same exact-tool and runtime gates as provider projection. */
function enabledParams(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): readonly ProfileToolParam[] {
    return (spec.parameters ?? []).filter((parameter) => {
        if (parameter.dependencies && parameter.dependencies.some((dependency) => !enabledToolIds.has(dependency))) {
            return false
        }
        return !parameter.contextRequirements || parameter.contextRequirements(context)
    })
}

/** Builds the established XML parameter documentation section. */
function parametersSection(params: readonly ProfileToolParam[]): string {
    if (params.length === 0) {
        return getPrompt("xmlProjection", "parametersNone")
    }
    return [
        getPrompt("xmlProjection", "parametersHeading"),
        ...params.map((parameter) =>
            assemblePromptFragments(getPrompt("xmlProjection", "parameterLine"), {
                NAME: parameter.name,
                REQUIREMENT: getPrompt("xmlProjection", parameter.required ? "required" : "optional"),
                INSTRUCTION: parameter.instruction,
            }),
        ),
    ].join("\n")
}

/** Builds the established XML usage example for one tool. */
function usageSection(toolName: string, params: readonly ProfileToolParam[]): string {
    return [
        getPrompt("xmlProjection", "usageHeading"),
        `<${toolName}>`,
        ...params.map((parameter) => `<${parameter.name}></${parameter.name}>`),
        `</${toolName}>`,
    ].join("\n")
}

/** Projects one canonical exact-profile descriptor to complete XML tool documentation. */
export function projectXmlTool(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): string {
    const params = enabledParams(spec, context, enabledToolIds)
    return [
        assemblePromptFragments(getPrompt("xmlProjection", "toolHeading"), { NAME: spec.name }),
        assemblePromptFragments(getPrompt("xmlProjection", "descriptionLine"), {
            DESCRIPTION: resolveProfilePromptText(spec.description, spec.descriptionFragments, context),
        }),
        parametersSection(params),
        usageSection(spec.name, params),
    ].join("\n")
}
