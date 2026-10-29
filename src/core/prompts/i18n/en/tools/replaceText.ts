// English prompts for replace_text tool — key-value pairs only.
const prompts: Record<string, string> = {
    description:
        'ALWAYS run with dry_run=true FIRST to preview changes before applying. Perform a global text replacement across multiple files matching a glob pattern. This operates at the text level (not semantic), replacing all occurrences of a literal or regex pattern. Substrings are matched: replacing "Hello" also changes "sayHello" to "sayHi". Set dry_run=true to preview changes without modifying files. Use this for bulk text changes like renaming strings, updating URLs, or fixing repeated typos. For single-file edits, use replace_in_file. For safe identifier-only renames that skip strings and comments, use rename (semantic).',
    standardDescription:
        'ALWAYS run with dry_run=true FIRST to preview changes before applying. Perform a global text replacement across all files matching a glob pattern. This operates at the text level (not semantic), replacing all occurrences of a literal or regex pattern. Substrings are matched: replacing "Hello" also changes "sayHello" to "sayHi". String literals and comments are also affected. Set dry_run=true to preview changes without modifying files. Use this for bulk text changes like renaming strings, updating URLs, or fixing repeated typos. Also use this to change only part of a line, even within one file: only the matched text changes and the rest of the line is kept, whereas replace_in_file replaces every matched line in full. For such an in-line edit, set file_pattern to the exact workspace-relative file path, make find long enough to occur only at the intended place, and confirm that the dry_run preview reports exactly 1 change before applying. Use replace_in_file to rewrite whole lines or multi-line blocks. For safe identifier-only renames that skip strings and comments, use rename (semantic, LSP-based).',
    findInstruction: "The text to search for. By default this is a literal string; set literal=false to use a regex pattern.",
    findUsage: "old_text",
    replaceInstruction: "The replacement text. Use an empty string to delete matches.",
    replaceUsage: "new_text",
    filePatternInstruction:
        "Glob pattern to filter files (e.g., '*.ts', '*.md', 'src/**/*.ts'). Only files matching this pattern in the workspace will be checked. An exact workspace-relative file path (e.g., 'src/app/config.ts') limits the replacement to that one file.",
    filePatternUsage: "*.ts",
    dryRunInstruction: "When true, returns a preview of all matches without modifying any files. Defaults to false.",
    literalInstruction:
        "When true (default), 'find' is treated as a literal string. When false, 'find' is treated as a regex pattern.",
    // Handler messages
    missingFind: "replace_text: missing required parameter 'find'.",
    noFilesMatched: 'No files matched pattern "@PATTERN@" in the workspace.',
    noOccurrences: 'No occurrences of "@FIND@" found in @COUNT@ files matching "@PATTERN@".',
    dryRunHeader: "Replace: @FIND@ -> @REPLACE@ (@FILES@ files, @MATCHES@ changes)@PREVIEW@\n",
    dryRunFooter: "No files were modified. Remove dry_run to apply changes.",
    dryRunMore: "... and {count} more occurrences.",
    successOutput: 'Replaced "@FIND@" → "@REPLACE@" in @FILES@ files, @MATCHES@ occurrences.',
    writeErrors: "(@COUNT@ files failed to write.)",
    errorPrefix: "replace_text failed: @ERROR@",
}
export default prompts
