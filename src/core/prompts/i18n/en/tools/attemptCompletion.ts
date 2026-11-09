// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `[TURN-END] After each tool use, the user will respond with the result of that tool use, i.e. if it succeeded or failed, along with any reasons for failure. Once you've received the results of tool uses and can confirm that the task is complete, use this tool to present the result of your work to the user. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.
IMPORTANT NOTE: This tool CANNOT be used until you've confirmed from the user that any previous tool uses were successful. Failure to do so will result in code corruption and system failure. Before using this tool, you must ask yourself in <thinking></thinking> tags if you've confirmed from the user that any previous tool uses were successful. If not, then DO NOT use this tool.`,
    gpt5Description: `[TURN-END] After each tool use, the user will respond with the result of that tool use, i.e. if it succeeded or failed, along with any reasons for failure. Once you've received the results of tool uses and can confirm that the task is complete, use this tool to present the result of your work to the user. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.
IMPORTANT NOTE: This tool CANNOT be used until you've confirmed from the user that any previous tool uses were successful and all tasks have been completed in full. Failure to do so will result in code corruption and system failure. Before using this tool, you must ask yourself in <thinking></thinking> tags if you've confirmed from the user that any previous tool uses were successful and all goals defined by the user have been completed. If not, then DO NOT use this tool.`,
    standardDescription: `[TURN-END] Use this tool when the user's entire current task is complete and the relevant verification is consistent. A completed TODO list shows that the tracked phase is done; it does not by itself establish that the full user objective is complete.

Before calling, compare the result with the latest user instruction, approved scope, expected deliverables, success criteria, verification evidence, known blockers, and work discovered during execution. Do not use this tool for a progress update, intermediate milestone, completed phase checklist, context-window pressure, automatic compaction, partial result, plan, report, question, or ordinary conversation. If work still remains to satisfy the user's request, continue the task instead.

Complete any existing TODO list before calling; do not pass task_progress.`,
    focusOmissionChecklistSentence: "\n\nComplete any existing TODO list before calling; do not pass task_progress.",
    resultInstruction: "The result of the tool use. This should be a clear, specific description of the result.",
    resultUsage: "Your final result description here",
    standardResultInstruction: `Write a clear, readable completion report adapted to the task.

- Start with the actual outcome and what was delivered.
- Use short descriptive headings, paragraphs, or bullet lists when they make the result easier to scan. Avoid an unbroken wall of text.
- Include relevant details about the completed work, verification performed and its results, material problems and their resolutions, and known remaining issues, risks, limitations, or unverified claims.
- Keep simple results brief. Use more structure when the task has multiple distinct outcomes or findings, without creating empty boilerplate sections or following a fixed template.
- State failed, skipped, or unavailable verification explicitly rather than implying that it passed.
- Do not hide known failures, blockers, incomplete work, or unresolved risks. If work still appears unfinished, continue the task instead of calling \`attempt_completion\`.`,
}
export default prompts
