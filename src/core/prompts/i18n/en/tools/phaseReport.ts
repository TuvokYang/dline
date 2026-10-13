// English prompts for phase_report — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Report a completed phase to the user without ending the turn, in PLAN or ACT MODE: what was completed, what verification showed, and what comes next. The report never waits for the user; continue with the next tool in the same turn.

Use it after a coherent phase or batch of changes or checks, at the moments USER COMMUNICATION defines. The purpose of an individual tool call and replies to messages the user sends during the work belong in working_respond, not here. A report cannot ask for confirmation, permission, or a decision; use ask_followup_question for those.

Do not call phase_report consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,
    focusOmissionDescriptionSentence: " Do not use it merely to update task_progress; checklist-only updates are silent.",

    standardDescription: `Report a completed phase to the user without ending the turn, in PLAN or ACT MODE: what was completed, what verification showed, and what comes next. The report never waits for the user; continue with the next tool in the same turn.

Use it after a coherent phase or batch of changes or checks, at the moments USER COMMUNICATION defines. The purpose of an individual tool call and replies to messages the user sends during the work belong in working_respond, not here. A report cannot ask for confirmation, permission, or a decision; use ask_followup_question for those.

Do not call phase_report consecutively; the next call must perform work. Do not use it for final completion — use attempt_completion. Do not use it merely to update task_progress; checklist-only updates are silent.`,

    responseInstruction: `The brief user-visible phase report: what was completed, what verification showed, and what comes next.`,

    responseUsage: "Your phase report here",

    taskProgressInstruction: `Optionally update the task progress checklist.`,
}
export default prompts
