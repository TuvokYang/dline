// English user instructions prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
    main: `USER'S CUSTOM INSTRUCTIONS

The following additional instructions are provided by the user and must be followed.

@CUSTOM_INSTRUCTIONS@`,
    fixedLanguage: `# Preferred Language

Speak in @LANGUAGE@.`,
    automaticLanguage: `# Preferred Language

Use the language of the user's most recent message. If it is mainly code, logs, or quoted material, use the language of the user's own prose; if none can be identified, keep the language already used in the conversation. Follow an explicit language instruction from the user for the current task.`,
}

export default prompts
