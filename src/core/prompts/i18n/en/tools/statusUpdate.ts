// English prompts for status_update tool — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description: `Provide a brief user-visible preamble, progress statement, or correction during task execution without ending the turn. By default, execution continues immediately so you can proceed with the next work tool without waiting.

Use this tool to tell the user what you will change and why, announce a completed phase and its verification result, explain a change in approach, acknowledge a correction or changed direction received during execution, or report and correct your own mistake.

Set requires_acknowledgment to true ONLY when you need the user to confirm before continuing — this displays "知晓" (acknowledge) and "停止" (stop) buttons. Otherwise leave it false and continue with actual work in the same turn.

Do not call status_update consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,
	focusOmissionDescriptionSentence:
		" Do NOT use status_update merely to update task_progress — task_progress updates are silent and should be done via the task_progress parameter on any tool call.",

	standardDescription: `Provide a brief user-visible preamble, progress statement, or correction during task execution without ending the turn. By default, execution continues immediately so you can proceed with the next work tool without waiting.

Use this tool to tell the user what you will change and why, announce a completed phase and its verification result, explain a change in approach, acknowledge a correction or changed direction received during execution, or report and correct your own mistake.

Set requires_acknowledgment to true ONLY when you need the user to confirm before continuing — this displays "知晓" (acknowledge) and "停止" (stop) buttons. Otherwise leave it false and continue with actual work in the same turn.

Do not call status_update consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,

	responseInstruction: `The brief user-visible message explaining the planned change, current progress, completed phase, correction, or relevant rationale.`,

	responseUsage: "Your announcement text here",

	requiresAcknowledgmentInstruction: `Set to true if you need the user to explicitly acknowledge before continuing. Defaults to false — execution continues immediately.`,

	requiresAcknowledgmentUsage: "true or false (defaults to false)",

	taskProgressInstruction: `Optionally update the task progress checklist.`,
}
export default prompts
