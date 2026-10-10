// English resume-provenance prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    interactionPresentation:
        "The previous task session was closed and has now been restored. Continue from the restored context.",
    missingToolResult:
        "The @TOOL_NAME@ result is missing because the prior session ended before it was stored. The tool outcome is unknown; do not infer success or failure from the missing record. If the tool could have changed observable state, inspect its observable state before retrying or continuing.",
    continuationWithUserText: "@PROVENANCE@\n\nUser continuation:\n@USER_TEXT@",
}

export default prompts
