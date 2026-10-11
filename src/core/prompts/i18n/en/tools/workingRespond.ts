// English prompts for working_respond — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Reply to the user while you keep working, in PLAN or ACT MODE, without ending the turn. It is the alignment channel between you and the user:
- Before tool calls, state what you are doing now and why.
- When a user message arrives during the work (a question, correction, or added detail), answer it, then continue.
- When the user corrects you, acknowledge the correction and say how your direction changes.

The message is displayed and work continues automatically. Always follow it with an actual work tool in the same turn. A reply never asks a question or requests approval; hand control back with a TURN-END tool only for a major decision, information only the user can provide, or a request to stop.

Do not use it for phase summaries; report a completed phase with phase_report. Do not call working_respond consecutively; after using it, the next call must perform work. Do not use it for final completion; use attempt_completion instead.`,
    responseInstruction:
        "The brief user-visible reply: what you are doing now and why, or your answer to the message the user sent during the work.",
    responseUsage: "Your message here",
    taskProgressInstruction:
        "A checklist showing task progress with the latest status of each subtasks included previously if any.",
}
export default prompts
