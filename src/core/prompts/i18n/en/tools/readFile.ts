// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description:
		"Request to read the contents of a file at the specified path. Use this when you need to examine the contents of an existing file you do not know the contents of, for example to analyze code, review text files, or extract information from configuration files. Returned text lines are prefixed with line labels (e.g. `1 |`, `2 |`). These labels are metadata, not part of the file content. For large files, output is automatically limited to 1000 lines. Use start_line and end_line to read specific sections. Automatically extracts raw text from PDF and DOCX files. May not be suitable for other types of binary files, as it returns the raw content as a string. Do NOT use this tool to list the contents of a directory. Only use it on files.",
	imageSupportDescription:
		"When image support is enabled, this tool can read supported image files and provide the image content for you to inspect. Image reads do not use start_line or end_line.",
	pathInstruction: `The file path. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@`,
	pathUsage: "File path here",
	startLineInstruction: "The 1-based line number to start reading from (inclusive). Defaults to 1.",
	startLineUsage: "1",
	endLineInstruction:
		"The 1-based line number to stop reading at (inclusive). Defaults to start_line + 1000. Use with start_line to read specific sections of large files.",
	endLineUsage: "1000",
}
export default prompts
