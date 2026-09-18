// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description:
		"Run up to @MAX_SUBAGENTS_PER_BATCH@ subagents from one call. Describe each one as an item in the subagents array; items run concurrently up to the configured subagent limit and the rest wait their turn, so a wide batch is accepted in full rather than trimmed. Each subagent returns a comprehensive research result with tool and token stats. Use this to preserve the main task's context window by delegating self-contained research. Keep each delegated research boundary independent from the main task's modification boundary: provide only the context needed for investigation, and do not treat files explored or reported by a subagent as authorized write scope. Using one item is valid.",
	singleDescription:
		"Run one focused default or named subagent. Omit agent_name or use 'default' for the built-in readonly research subagent; use an advertised YAML name for a configured agent. Use this to preserve the main task's context window through self-contained research. Keep the delegated research boundary independent from the main task's modification boundary, and do not infer write authorization from files the subagent explores or reports.",
	agentNameInstruction: "Optional advertised subagent name. Omit or use 'default' for the built-in default profile.",
	taskInstruction: "Focused task for the subagent.",
	contextInstruction:
		"Relevant context, constraints, and expected result for the subagent. Include enough context for independent research, but do not use this field to expand or redefine the main task's modification boundary.",
	subagentsInstruction:
		"The subagents to run, 1 to @MAX_SUBAGENTS_PER_BATCH@ items. Each item is configured independently and needs at least task and context.",
	itemAgentNameInstruction:
		"Optional advertised subagent name for this item. Omit or use 'default' for the built-in default profile.",
	itemTaskInstruction: "Focused task for this subagent.",
	itemContextInstruction:
		"Relevant context, constraints, and expected result for this subagent. Include enough context for independent research, but do not use this field to expand or redefine the main task's modification boundary.",
	itemProfileInstruction:
		"Optional API Profile for this item. Naming one binds this subagent to it; if that Profile is unavailable or not enabled for subagents, this item fails instead of quietly running on another one. Omit to use the agent's configured Profile, or the parent Act Profile.",
	itemTimeoutInstruction:
		"Optional positive integer timeout in seconds for this item. Omit to use the call's shared timeout. Timing starts when the item begins executing, not when the batch is submitted.",
	backgroundInstruction: "Optional boolean. Set true to run in background. Defaults to false.",
	timeoutInstruction:
		"Optional positive integer timeout in seconds, applied to every item that does not set its own. Defaults to @SUBAGENT_TIMEOUT_SECONDS@.",
}
export default prompts
