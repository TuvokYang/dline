// English InputQueue delivery prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
    auxiliaryAlignmentV1:
        "The following message was sent by the user while work was in progress and is now part of the current conversation. " +
        "Process it according to USER AUTHORITY and USER COMMUNICATION: reply to it with working_respond, then continue the work. " +
        "Hand control back with a TURN-END tool only when it requires a major decision or asks you to stop.",
}

export default prompts
