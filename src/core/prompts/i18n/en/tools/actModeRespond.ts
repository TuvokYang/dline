// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description: `Provide a brief user-visible preamble or progress update during ACT MODE without ending the turn. After displaying the message, execution continues automatically so you can proceed with the next work tool immediately.

Use this tool to keep the user informed throughout execution. Use it at least:
- After inspecting relevant files and before modifying files or running state-changing commands: explain what you will change, where, and why
- After a coherent batch of changes or checks: report what was completed, what verification showed, and what comes next
- When the user corrects or redirects work during execution: acknowledge the correction, explain its effect on the current approach, and then continue
- When you find or correct your own mistake, a result contradicts your expectation, or your approach changes
- Before complex or potentially risky operations

Keep the update brief and conversational. Always follow it with an actual work tool in the same turn. Do not call act_mode_respond consecutively; after using it, the next call must perform work. Do not use it for final completion; use attempt_completion instead.`,
	responseInstruction:
		"The brief user-visible message explaining the planned change, current progress, completed phase, correction, or relevant rationale.",
	responseUsage: "Your message here",
	taskProgressInstruction:
		"A checklist showing task progress with the latest status of each subtasks included previously if any.",
}
export default prompts
