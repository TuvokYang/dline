// English prompts for find_references tool — key-value pairs only.
const prompts: Record<string, string> = {
	description:
		"Find all semantic references to a symbol at the given file position via the IDE's LSP. Returns file paths, line numbers, and context lines for each reference (definitions, imports, calls). This does NOT find occurrences in string literals, comments, or JSDoc. An empty result may mean the LSP does not support this language or file type, not that no references exist. Use this before renaming or refactoring to understand semantic impact. To search strings and comments, use search_files with regex. Only available in VSCode; other environments return an error suggesting search_files as a fallback.",
	standardDescription:
		"Find all semantic references to a symbol at the given file position via the IDE's LSP. Returns file paths, line numbers, and context lines for each reference (definitions, imports, calls). This does NOT find occurrences in string literals, comments, or JSDoc. An empty result may mean the LSP does not support this language or file type, not that no references exist. Use this before renaming or refactoring to understand semantic impact. To search strings and comments, use search_files with regex. Only available in VSCode; other environments return an error suggesting search_files as a fallback.",
	filePathInstruction: "The workspace-relative path to the file containing the symbol. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@",
	filePathUsage: "src/path/to/file.ts",
	lineInstruction: "1-based line number where the symbol appears.",
	characterInstruction: "1-based character offset on the line where the symbol starts.",
	// Handler messages
	noLspSupport: "Error: LSP not available. Use search_files instead.",
	invalidPath: "Error: file not found at '@PATH@'. Pass a path that exists in the workspace.",
	outsideWorkspace:
		"Error: '@PATH@' is outside the workspace, so the language server does not index it. Use search_files instead.",
	noLanguageSupport: "Error: no language server handles this file type. Use search_files instead.",
	noReferences: "Error: no references found for the symbol.",
	foundReferences: "Found {count} references in the workspace:",
	errorPrefix: "Error: @ERROR@",
}
export default prompts
