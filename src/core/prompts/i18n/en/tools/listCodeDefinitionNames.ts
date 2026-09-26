// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description:
		"Request to list definition names (classes, functions, methods, etc.) used in source code files at the top level of the specified directory. This tool provides insights into the codebase structure and important constructs, encapsulating high-level concepts and relationships that are crucial for understanding the overall architecture. Each definition is prefixed with its start-end line range (e.g., '23-45 | function foo() {').",
	pathInstruction: `The directory path, not a file path. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@ Lists definitions across all source files in that directory. To inspect a single file, use read_file instead.`,
	pathUsage: "Directory path here",
}
export default prompts
