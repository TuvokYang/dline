// English prompts for spawn_task tool — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Spawn a first-class peer task, not a subagent. The spawned task runs independently with its own conversation context and the normal task capability and approval model. It does NOT inherit the parent's conversation history. Use the task parameter for goals, mode to choose whether it starts in PLAN or ACT mode, and context for background information. The task starts immediately in the background, inheriting the parent's API profile for the selected mode, MCP servers, and rules. The user must approve before creation.`,
    taskInstruction: `Describe what the spawned task should investigate or execute. Be specific about the goals and expected work to be done.`,
    taskUsage: "Task description here",
    modeInstruction: `Required startup mode. Use "plan" for investigation or planning and "act" for implementation or other state-changing work.`,
    contextInstruction: `Provide relevant background context for the spawned task. Include: why this task is needed, relevant conversation history or prior work, key technical concepts, constraints, and configuration. The spawned task cannot access the parent's conversation history — include everything it needs to know.`,
    contextUsage: "additional context (optional)",
}
export default prompts
