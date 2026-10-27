import type { MistakeLimitReason } from "./types"

/**
 * The recovery only opens after the model kept failing Dline's tool protocol.
 * That is evidence about the model rather than the task, so every reason ends by
 * asking the user to judge whether this model can do the work.
 */
const CAPABILITY_GUIDANCE =
    "Dline runs work through a strict multi-step tool protocol, so repeated mistakes usually mean this model is not " +
    "capable enough for this task. Evaluate the model carefully and consider switching to a stronger one, or add " +
    "guidance and choose Process Anyway."

const REASON_SUMMARIES: Readonly<Record<MistakeLimitReason, string>> = {
    rule_violations: "The model repeatedly broke Dline's tool rules by answering in plain text without calling any tool.",
    no_tool_turns: "The model repeatedly answered without a usable tool call.",
    tool_mistakes: "The model repeatedly made invalid tool calls.",
}

/** Body of the "Task Needs Attention" recovery for one exhausted budget. */
export function mistakeLimitPresentation(reason: MistakeLimitReason): string {
    return `${REASON_SUMMARIES[reason]} ${CAPABILITY_GUIDANCE}`
}
