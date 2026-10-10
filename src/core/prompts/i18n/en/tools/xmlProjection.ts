// English XML projection prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    parametersNone: "Parameters: None",
    parametersHeading: "Parameters:",
    parameterLine: "- @NAME@: (@REQUIREMENT@) @INSTRUCTION@",
    required: "required",
    optional: "optional",
    usageHeading: "Usage:",
    toolHeading: "## @NAME@",
    descriptionLine: "Description: @DESCRIPTION@",
}

export default prompts
