// English prompts - key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `[TURN-END] Present a COMPLETE implementation or design plan covering ALL user requirements. Available in both ACT and PLAN modes. In ACT MODE, use this tool only when the user explicitly requests a plan. In PLAN MODE, use it after thorough exploration and analysis when ready to present the plan. Include the full plan, detailed analysis, architecture decisions, and every implementation step for review. Do not call repeatedly; use qna_respond for questions and discussion. If more exploration is needed, set needs_more_exploration.

Follow the TODO update rules when providing task_progress.`,
    focusOmissionDescriptionClause: "\n\nFollow the TODO update rules when providing task_progress.",
    responseInstruction:
        "The response to provide to the user. Do not call tools inside this parameter. You MUST use the response parameter rather than placing response text directly inside <make_plan>.",
    responseUsage: "Your response here",
    standardResponseInstruction: "The complete implementation or design plan to provide to the user.",
    needsMoreExplorationInstruction:
        "Set to true if formulating the plan reveals that more exploration with read/search tools is required. Defaults to false.",
    needsMoreExplorationUsage: "true or false",
    taskProgressInstruction:
        "A checklist showing task progress after this tool use is completed. (See 'Updating Task Progress' for details.)",
    taskProgressUsage:
        "Checklist here (When presenting an implementation plan, include the complete checklist for its implementation steps.)",
    standardTaskProgressInstruction: "A checklist showing the latest status of all previously introduced subtasks.",
}
export default prompts
