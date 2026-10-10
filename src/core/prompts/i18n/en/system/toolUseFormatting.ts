// English tool use formatting prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
    focusChainExample: `<task_progress>
Checklist here (optional)
</task_progress>\n`,

    main: `# Tool Use Formatting

Tool use is formatted using XML-style tags. The tool name is enclosed in opening and closing tags, and each parameter is similarly enclosed within its own set of tags. Here's the structure:

<tool_name>
<parameter1_name>value1</parameter1_name>
<parameter2_name>value2</parameter2_name>
...
</tool_name>

For example:

<read_file>
<path>src/main.js</path>
@FOCUS_CHATIN_FORMATTING@</read_file>

Always adhere to this format for the tool use to ensure proper parsing and execution.\n`,
}

export default prompts
