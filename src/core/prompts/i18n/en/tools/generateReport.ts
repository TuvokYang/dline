// English prompts for generate_report tool — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `[TURN-END] Generate a structured technical report for the user to review. This tool pauses execution and waits for the user to respond before you can continue. Use this when the user requests a formal report, summary of findings, or technical analysis that requires their review before proceeding to the next steps.

The report should include relevant code snippets, architectural decisions, error analysis, or performance data as appropriate. After the user reviews the report, they will provide feedback or instructions for the next steps.`,

    standardDescription: `[TURN-END] Generate a structured technical report for the user to review. This tool pauses execution and waits for the user to respond before you can continue. Use this when the user requests a formal report, summary of findings, or technical analysis that requires their review before proceeding to the next steps.

The report should include relevant code snippets, architectural decisions, error analysis, or performance data as appropriate. After the user reviews the report, they will provide feedback or instructions for the next steps.`,

    titleInstruction: `A concise, descriptive title for the report.`,

    titleUsage: "Investigation: Memory Leak in Authentication Module",

    contentInstruction: `The full report content. Use markdown formatting for readability. Include sections like Background, Findings, Analysis, Recommendations as appropriate.`,

    contentUsage: "## Background\n...\n## Findings\n...\n## Recommendations\n...",

    taskProgressInstruction: `Optionally update the task progress checklist.`,
}
export default prompts
