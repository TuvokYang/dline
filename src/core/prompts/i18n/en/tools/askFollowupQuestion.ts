// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description:
        "[TURN-END] Ask the user a question to gather additional information needed to complete the task. This tool should be used when you encounter ambiguities, need clarification, or require more details to proceed effectively. It allows for interactive problem-solving by enabling direct communication with the user. Use this tool judiciously to maintain a balance between gathering necessary information and avoiding excessive back-and-forth.",
    standardDescription:
        "[TURN-END] Ask one focused question only when continuing requires a user-provided detail or decision that available tools cannot determine, or when at least two failed approaches leave the task genuinely blocked. Avoid unnecessary back-and-forth.",
    questionInstruction:
        "The question to ask the user. This should be a clear, specific question that addresses the information you need.",
    questionUsage: "Your question here",
    standardQuestionInstruction:
        "The question to ask the user. This should be a clear, specific question that addresses the information you need. Ask only one question.",
    optionsInstruction:
        "An array of 2-5 options for the user to choose from. Each option should be a string describing a possible answer. You may not always need to provide options, but it may be helpful in many cases where it can save the user from having to type out a response manually. IMPORTANT: NEVER include an option to toggle to Act mode, as this would be something you need to direct the user to do manually themselves if needed.",
    optionsUsage: 'Array of options here (optional), e.g. ["Option 1", "Option 2", "Option 3"]',
    standardOptionsInstruction:
        'An array of 2-5 options (e.x: "["Option 1", "Option 2", "Option 3"]") for the user to choose from. Each option should be a string describing a possible answer to the single question. You may not always need to provide options, but it may be helpful in many cases where it can save the user from having to type out a response manually. IMPORTANT: NEVER include an option to toggle to Act mode, as this would be something you need to direct the user to do manually themselves if needed.',
}
export default prompts
