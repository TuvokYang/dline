// English prompts for qna_respond tool — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `[TURN-END] Use this tool whenever the user asks a question or requests clarification. This MUST be your first response tool for any user question. Do NOT use attempt_completion or make_plan to answer questions; make_plan is for presenting implementation or design plans and, in ACT MODE, only when the user explicitly requests one. Available in both PLAN and ACT modes.`,

    responseInstruction: `The detailed answer to the user's question. Provide a clear, thorough explanation. Use code snippets, examples, and references as needed.`,

    responseUsage: "Your detailed answer here",

    taskProgressInstruction: `Optionally update the task progress checklist after answering.`,

    standardDescription: `[TURN-END] Use this tool whenever the user asks a question or requests clarification. This MUST be your first response tool for any user question. Do NOT use attempt_completion or make_plan to answer questions; make_plan is for presenting implementation or design plans and, in ACT MODE, only when the user explicitly requests one. Available in both PLAN and ACT modes.`,

    standardResponseInstruction: `The detailed answer to the user's question. Provide a clear, thorough explanation. Use code snippets, examples, and references as needed.`,
}
export default prompts
