// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	mcpDescription:
		"Load detailed read-only metadata and the input schema for one advertised MCP tool. Loading does not execute the MCP tool; call use_mcp_tool separately when execution is required.",
	skillDescription:
		"Load the full instructions for one advertised Skill. Call this tool once with the exact Skill name, then follow the returned instructions directly for the current task. Do not call it when the Skill was already injected through an `<explicit_instructions>` block.",
	workflowDescription:
		"Load the full procedure for one advertised Workflow. Call this tool once with the exact Workflow name, then follow the returned steps in order. Do not call it when the Workflow was already injected through an `<explicit_instructions>` block.",
	mcpNameInstruction: "The exact advertised MCP tool name whose metadata and input schema should be loaded.",
	skillNameInstruction: "The exact advertised Skill name whose full instructions should be loaded.",
	workflowNameInstruction: "The exact advertised Workflow name whose full procedure should be loaded.",
}
export default prompts
