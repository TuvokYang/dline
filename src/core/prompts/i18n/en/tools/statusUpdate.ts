// English prompts for status_update tool — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Provide a brief user-visible preamble, progress statement, or correction during task execution without ending the turn. By default, execution continues immediately so you can proceed with the next work tool without waiting.

Use it at the moments USER COMMUNICATION defines, including acknowledging a correction received during execution.

Set requires_acknowledgment to true ONLY when the user should read this message before you continue — this displays Acknowledge and Stop buttons. Acknowledgment confirms only that the user has seen the message; it is not permission or a decision. Request permission or a decision with ask_followup_question. Otherwise leave it false and continue with actual work in the same turn.

Do not call status_update consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,
    focusOmissionDescriptionSentence: " Do not use it merely to update task_progress; checklist-only updates are silent.",

    standardDescription: `Provide a brief user-visible preamble, progress statement, or correction during task execution without ending the turn. By default, execution continues immediately so you can proceed with the next work tool without waiting.

Use it at the moments USER COMMUNICATION defines, including acknowledging a correction received during execution.

Set requires_acknowledgment to true ONLY when the user should read this message before you continue — this displays Acknowledge and Stop buttons. Acknowledgment confirms only that the user has seen the message; it is not permission or a decision. Request permission or a decision with ask_followup_question. Otherwise leave it false and continue with actual work in the same turn.

Do not call status_update consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,

    responseInstruction: `The brief user-visible message explaining the planned change, current progress, completed phase, correction, or relevant rationale.`,

    responseUsage: "Your announcement text here",

    requiresAcknowledgmentInstruction: `Set to true only when the user should read the message before you continue; acknowledgment is not permission. Defaults to false — execution continues immediately.`,

    requiresAcknowledgmentUsage: "true or false (defaults to false)",

    taskProgressInstruction: `Optionally update the task progress checklist.`,
}
export default prompts
