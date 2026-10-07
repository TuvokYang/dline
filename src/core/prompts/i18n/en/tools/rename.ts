// English prompts for rename tool — key-value pairs only.
const prompts: Record<string, string> = {
	description:
		"Rename a symbol at the given file position using the IDE's LSP (semantic rename). This renames the symbol across all files, distinguishing between symbol references, comments, and string literals. Set dry_run=true to preview changes without applying them. Only available in VSCode; other environments return an error suggesting replace_text or replace_in_file as a fallback.",
	standardDescription:
		"Rename a symbol at the given file position using the IDE's LSP (semantic rename). Only renames symbol references (definitions, imports, calls); skips string literals, comments, and JSDoc. Set dry_run=true to preview changes without applying them. If LSP returns no edits, the rename could not be performed (language or project may not be supported). Only available in VSCode; for text-level renaming including strings and comments, use replace_text instead.",
	filePathInstruction: "The workspace-relative path to the file containing the symbol. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@",
	filePathUsage: "src/path/to/file.ts",
	lineInstruction: "1-based line number where the symbol appears.",
	characterInstruction: "1-based character offset on the line where the symbol starts.",
	newNameInstruction: "The new name for the symbol. Use camelCase/PascalCase/snake_case as appropriate for the language.",
	newNameUsage: "newSymbolName",
	dryRunInstruction: "When true, returns a preview of all changes without actually modifying any files. Defaults to false.",
	// Handler messages
	noLspSupport: "Error: LSP not available. Use replace_text instead.",
	invalidPath: "Error: file not found at '@PATH@'. Pass a path that exists in the workspace.",
	outsideWorkspace:
		"Error: '@PATH@' is outside the workspace, so the language server cannot rename symbols in it. Use replace_text instead.",
	noLanguageSupport: "Error: no language server handles this file type. Use replace_text instead.",
	missingParams: "Error: missing required parameters.",
	noEdits: "Error: rename failed. No edits returned by LSP.",
	failedApply: "rename: VSCode failed to apply the rename edit.",
	errorPrefix: "Error: @ERROR@",
	dryRunHeader: "Rename: @OLD_NAME@ -> @NEW_NAME@ (@FILES@ files, @CHANGES@ changes) (preview)\n",
	dryRunFooter: "No files were modified. Remove dry_run to apply changes.",
	successOutput: "Rename: @OLD_NAME@ -> @NEW_NAME@ (@FILES@ files, @CHANGES@ changes)\n",
	fileEditLine: "\n@FILE@ L@LINE@:@CHARACTER@\n  @ORIGINAL@\n  @NEW@\n",
	fileEditLineApplied: "  L{line}: → {new}",
}
export default prompts
