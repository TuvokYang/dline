// English prompts for phase_report — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Report a completed phase to the user without ending the turn, in PLAN or ACT MODE: what was completed, what verification showed, and what comes next. By default, work continues immediately so you can proceed with the next tool without waiting.

Use it after a coherent phase or batch of changes or checks, at the moments USER COMMUNICATION defines. The purpose of an individual tool call and replies to messages the user sends during the work belong in working_respond, not here.

Set requires_acknowledgment to true ONLY when the user should read this report before you continue — this displays Acknowledge and Stop buttons. Acknowledgment confirms only that the user has seen the report; it is not permission or a decision. Request permission or a decision with ask_followup_question. Otherwise leave it false and continue with actual work in the same turn.

Do not call phase_report consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,
    focusOmissionDescriptionSentence: " Do not use it merely to update task_progress; checklist-only updates are silent.",

    standardDescription: `Report a completed phase to the user without ending the turn, in PLAN or ACT MODE: what was completed, what verification showed, and what comes next. By default, work continues immediately so you can proceed with the next tool without waiting.

Use it after a coherent phase or batch of changes or checks, at the moments USER COMMUNICATION defines. The purpose of an individual tool call and replies to messages the user sends during the work belong in working_respond, not here.

Set requires_acknowledgment to true ONLY when the user should read this report before you continue — this displays Acknowledge and Stop buttons. Acknowledgment confirms only that the user has seen the report; it is not permission or a decision. Request permission or a decision with ask_followup_question. Otherwise leave it false and continue with actual work in the same turn.

Do not call phase_report consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,

    responseInstruction: `The brief user-visible phase report: what was completed, what verification showed, and what comes next.`,

    responseUsage: "Your phase report here",

    requiresAcknowledgmentInstruction: `Set to true only when the user should read the report before you continue; acknowledgment is not permission. Defaults to false — work continues immediately.`,

    requiresAcknowledgmentUsage: "true or false (defaults to false)",

    taskProgressInstruction: `Optionally update the task progress checklist.`,
}
export default prompts
