// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description:
		"Request to write content to a NEW file at the specified path. Use this tool ONLY for creating files that do not already exist. For editing existing files, always use replace_in_file. This tool will automatically create any directories needed to write the file.",
	standardDescription:
		"[IMPORTANT: Always output the absolutePath first] Request to write content to a NEW file at the specified path. Use this tool ONLY for creating files that do not already exist. For editing existing files, always use replace_in_file. This tool will automatically create any directories needed to write the file.",
	pathInstruction: `The file path. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@`,
	pathUsage: "File path here",
	standardPathInstruction: "The absolute path to the file to write to.",
	contentInstruction:
		"The content to write to the file. ALWAYS provide the COMPLETE intended content of the file, without any truncation or omissions. You MUST include ALL parts of the file, even if they haven't been modified.",
	contentUsage: "Your file content here",
	standardContentInstruction:
		"The content to write to the file. ALWAYS provide the COMPLETE intended content of the file, without any truncation or omissions. You MUST include ALL parts of the file, even if they haven't been modified.",
	diffMatchFailed:
		"Blank result -- the SEARCH text did not match anything in the file. Re-read the file and try again with the exact current content.",
	writeToFileBaseError:
		"Failed to write to '@REL_PATH@': The 'content' parameter was empty. This typically happens when the file content is too large to generate in a single response, or when output token limits are reached before the content parameter is fully written.",
	writeToFileContextWarning:
		"Warning: Context window is @CONTEXT_USAGE_PERCENT@% full. The remaining output budget may be insufficient for large file writes. You MUST use a strategy that produces smaller outputs.",
	writeToFileCriticalFail: `CRITICAL: You have failed to write this file @CONSECUTIVE_FAILURES@ times in a row. You MUST change your approach — do NOT retry write_to_file for this file again.

Required action — choose ONE of these strategies:
1. **Create an empty file first, then use replace_in_file** to add content in small sections (recommended)
2. **Break the file into multiple smaller files** if architecturally appropriate
3. **Write a minimal skeleton** using write_to_file (just imports, class/function signatures, no implementations), then use replace_in_file to fill in each section one at a time

Each replace_in_file call should add no more than 50-100 lines of content at a time.`,
	writeToFileSecondFail: `This is your @ATTEMPT_ORDINAL@ failed attempt. The file content is likely too large to generate in one response. You must use a different strategy:

Recommended approaches:
1. **Use write_to_file with a minimal skeleton** (just the structure — imports, class/function signatures, no implementations), then use replace_in_file to fill in each section incrementally
2. **Use replace_in_file with smaller chunks** — if the file already exists, make targeted edits instead of rewriting the entire file
3. **Break the task into smaller steps** — write one function or section at a time

Do NOT attempt to write the full file content in a single write_to_file call again.`,
	writeToFileFirstFail: `Suggestions:
- If the file is large, try breaking down the task into smaller steps. Write a skeleton first, then fill in sections using replace_in_file.
- If the file already exists, prefer replace_in_file to make targeted edits instead of rewriting the entire file.
- Ensure the 'content' parameter contains the complete file content before closing the tool tag.

@TOOL_REMINDER@`,
	fileEditUserChangesHead: "The user made the following updates to your content:\n\n@USER_EDITS@\n\n",
	fileEditAutoFormattingWithChanges:
		"The user's editor also applied the following auto-formatting to your content:\n\n@AUTO_FORMATTING_EDITS@\n\n(Note: Pay close attention to changes such as single quotes being converted to double quotes, semicolons being removed or added, long lines being broken into multiple lines, adjusting indentation style, adding/removing trailing commas, etc. This will help you ensure future SEARCH/REPLACE operations to this file are accurate.)\n\n",
	fileEditAutoFormattingWithoutChanges:
		"Along with your edits, the user's editor applied the following auto-formatting to your content:\n\n@AUTO_FORMATTING_EDITS@\n\n(Note: Pay close attention to changes such as single quotes being converted to double quotes, semicolons being removed or added, long lines being broken into multiple lines, adjusting indentation style, adding/removing trailing commas, etc. This will help you ensure future SEARCH/REPLACE operations to this file are accurate.)\n\n",
	fileEditUpdatedContent:
		"The updated content has been successfully saved to @REL_PATH@. (wrote @WROTE_LINES@ lines, saved @SAVED_LINES@ lines)\n\n",
	fileEditSuccessContent:
		"The content was successfully saved to @REL_PATH@. (wrote @WROTE_LINES@ lines, saved @SAVED_LINES@ lines)\n",
	replaceEditSuccessContent:
		"The content was successfully replaced in @REL_PATH@. (deleted @DELETED_LINES@ lines, added @ADDED_LINES@ lines, saved @SAVED_LINES@ lines)\n",
	formatterChangedNotice:
		"Note: The file was modified by formatter after saving. Re-read the file before any future replace_in_file operations.\n",
	fileEditNotesWithChanges:
		"Please note:\n1. You do not need to re-write the file with these changes, as they have already been applied.\n2. Proceed with the task using this updated file content as the new baseline.\n3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.\n\n@NEW_PROBLEMS_MESSAGE@",
	fileEditNotesWithoutChanges: "@NEW_PROBLEMS_MESSAGE@",
	fileVerbSingular: "file has",
	fileVerbPlural: "files have",
	fileDemonstrativeSingular: "this file",
	fileDemonstrativePlural: "these files",
	filePronounSingular: "it",
	filePronounPlural: "they",
	fileContextWarning: `<explicit_instructions>
CRITICAL FILE STATE ALERT: @FILE_COUNT@ @FILE_VERB@ been externally modified since your last interaction. Your cached understanding of @FILE_DEMONSTRATIVE_PRONOUN@ is now stale and unreliable. Before making ANY modifications to @FILE_DEMONSTRATIVE_PRONOUN@, you must execute read_file to obtain the current state, as @FILE_PERSONAL_PRONOUN@ may contain completely different content than what you expect:
@FILES_LIST@
Failure to re-read before editing will result in replace_in_file edit errors, requiring subsequent attempts and wasting tokens. You DO NOT need to re-read these files after subsequent edits, unless instructed to do so.
</explicit_instructions>`,
}
export default prompts
