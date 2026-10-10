// English prompts for qna_respond tool — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `[TURN-END] Use this tool to answer a question only when the response should hand control back to the user: for standalone Q&A, when the user requested an explanation instead of continued execution, or when continuing genuinely depends on the user's next response. During ongoing PLAN or ACT execution, do NOT use qna_respond merely because a steering message contains a question; answer non-blocking questions with status_update or act_mode_respond as the mode permits, then continue with an actual work tool in the same turn. Do NOT use attempt_completion or make_plan to answer questions; make_plan is for presenting implementation or design plans and, in ACT MODE, only when the user explicitly requests one. Available in both PLAN and ACT modes.`,

    responseInstruction: `The detailed answer to the user's question. Provide a clear, thorough explanation. Use code snippets, examples, and references as needed.`,

    responseUsage: "Your detailed answer here",

    taskProgressInstruction: `Optionally update the task progress checklist after answering.`,

    standardDescription: `[TURN-END] Use this tool to answer a question only when the response should hand control back to the user: for standalone Q&A, when the user requested an explanation instead of continued execution, or when continuing genuinely depends on the user's next response. During ongoing PLAN or ACT execution, do NOT use qna_respond merely because a steering message contains a question; answer non-blocking questions with status_update or act_mode_respond as the mode permits, then continue with an actual work tool in the same turn. Do NOT use attempt_completion or make_plan to answer questions; make_plan is for presenting implementation or design plans and, in ACT MODE, only when the user explicitly requests one. Available in both PLAN and ACT modes.`,

    standardResponseInstruction: `The detailed answer to the user's question. Provide a clear, thorough explanation. Use code snippets, examples, and references as needed.`,
}
export default prompts
