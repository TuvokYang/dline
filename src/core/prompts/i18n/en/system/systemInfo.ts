// English system info prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	main: `SYSTEM INFORMATION

Operating System: @OS@
IDE: @IDE@
Default Shell: @SHELL@
Workspace Names:@WORKSPACE_NAMES@
Workspace Path Rule: @WORKSPACE_PATH_RULE@`,
}

export default prompts
