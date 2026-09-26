// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description:
		"Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context. Each result line is prefixed with its line number (e.g., '42 | code content'), matching the read_file format.",
	pathInstruction: `The directory path to search. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@ This directory will be recursively searched.`,
	pathUsage: "Directory path here",
	regexInstruction: "The regular expression pattern to search for. Uses Rust regex syntax.",
	regexUsage: "Your regex pattern here",
	filePatternInstruction:
		"Glob pattern to filter files (e.g., '*.ts' for TypeScript files). If not provided, it will search all files (*).",
	filePatternUsage: "file pattern here (optional)",
}
export default prompts
