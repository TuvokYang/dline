// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description:
		"Request to edit an existing file using SEARCH/REPLACE blocks. PREFER this tool for all edits to existing files. Only use write_to_file for creating new files.",
	standardDescription:
		"[IMPORTANT: Always output the absolutePath first] Request to edit an existing file using SEARCH/REPLACE blocks. PREFER this tool for all edits to existing files. Only use write_to_file for creating new files.",
	pathInstruction: "The workspace-relative path of the file to modify.",
	pathUsage: "File path here",
	standardPathInstruction: "The absolute path to the file to write to.",
	baseDiffInstructions: `One or more SEARCH/REPLACE blocks following this exact format:
\`\`\`
------- SEARCH
[lines to find]
=======
[new content to replace with]
+++++++ REPLACE
\`\`\`
Critical rules:
1. SEARCH lines are matched against whole file lines:
    * Each SEARCH line must be the complete file line or its beginning (a line prefix). Never start a SEARCH line in the middle of a file line.
    * Leading indentation may be omitted, and leading/trailing whitespace differences are tolerated.
    * Consecutive SEARCH lines may each be a prefix, but they must be consecutive lines of the file. Blank SEARCH lines only match blank file lines.
2. Each SEARCH block must match exactly ONE location in the whole file:
    * A block that matches several locations is rejected and the candidate line numbers are returned. Add more leading characters or a distinctive adjacent line, then retry.
    * Use multiple SEARCH/REPLACE blocks for multiple changes. List them in the order they appear in the file; they must not overlap.
3. Every matched line is replaced in full, and REPLACE is inserted verbatim:
    * Write every replacement line completely, including its exact indentation.
    * Nothing from the matched lines is kept automatically: neither the indentation nor the unwritten rest of a prefix line.
4. SKIP ranges delete or rewrite a long range without copying it (saves output tokens):
    * In SEARCH, write the head line(s), then one line that is exactly \`....... SKIP\` (as many dots as your delimiter length), then the tail line(s):
------- SEARCH
export function legacyParse(input: string) {
....... SKIP
}
=======
+++++++ REPLACE
    * The head must match exactly one location. The range ends at the first tail match after the head; an exact tail match is preferred over looser ones.
    * EVERY line from the first head line through the last tail line, including all skipped lines, is deleted and replaced by REPLACE. Skipped lines are NOT preserved: write any line you want to keep in REPLACE, or use smaller blocks.
    * At most one SKIP line per block. It cannot be the first or last SEARCH line, and it must never appear in REPLACE.
    * Use SKIP only for a range you have just read and intend to remove or rewrite entirely, then check the replaced line range reported in the result.
5. Keep SEARCH/REPLACE blocks concise:
    * Break large SEARCH/REPLACE blocks into a series of smaller blocks that each change a small portion of the file.
    * Include just the changing lines, and a few surrounding lines if needed for uniqueness.
    * Do not include long runs of unchanging lines in SEARCH/REPLACE blocks.
    * Only SEARCH lines may be shortened, and only at their end. REPLACE lines must always be complete.
6. Special operations:
    * To move code: Use two SEARCH/REPLACE blocks (one to delete from original + one to insert at new location)
    * To delete code: Use empty REPLACE section (combine it with SKIP for long ranges)
7. If your source context came from read_file and includes line labels (for example, "42 | const x = 1"), do NOT include the "42 | " prefix in SEARCH or REPLACE content. Match only the raw file text.
8. DELIMITER CONFLICT: If any line in your SEARCH content starts with 7+ dashes followed by " SEARCH", or is exactly 7+ "=" signs, or starts with 7+ "+" followed by " REPLACE", or is exactly 7+ "." followed by " SKIP", change your delimiter count to a unique value (>= 7). The count must not match any content line format. All markers within a block, including SKIP, must use the same count.
9. FAILURE RECOVERY: If a SEARCH block fails to match:
    - Not found: re-read the file with read_file and write each SEARCH line from the beginning of the file line; never start in the middle of a line.
    - Ambiguous: extend the line prefixes with more characters, or include an adjacent line that exists only at the intended location.
    - SKIP tail not found: make sure the tail lines really appear after the head.
    - You MUST use replace_in_file for editing existing files. If replace_in_file cannot complete the affected operation, stop and wait for the user to decide whether command-line tools are authorized for a task specified by the user. If the user already gave that authorization for the specified task, it remains valid; risk assessment and requires_approval are unchanged.
    - Always re-read the file before retrying after a failed match.`,
	notebookInstructions: `
10. For Jupyter Notebook (.ipynb) files:
    * Match the exact JSON structure including quotes, commas, and \\n characters
    * Each line in "source" array (except last) must end with "\\n"
    * Each source line is a separate JSON string in the array
    * Example SEARCH block for notebook:
------- SEARCH
    "source": [
    "x = 10\\n",
    "print(x)"
    ]
=======
    "source": [
    "x = 100\\n",
    "print(x)"
    ]
+++++++ REPLACE`,
	diffUsage: "Search and replace blocks here",
	replaceInFileMissingDiffError: `Failed to edit '@REL_PATH@': The 'diff' parameter was empty.

The diff parameter must contain SEARCH/REPLACE blocks in this format:
------- SEARCH
exact lines to find
=======
replacement lines
+++++++ REPLACE

Rules:
- Each SEARCH line must be a complete file line or the beginning of one (leading indentation may be omitted); never start in the middle of a line
- Each SEARCH block must match exactly one location in the file
- Matched lines are replaced in full, so REPLACE must contain complete lines with their indentation
- You can include multiple SEARCH/REPLACE blocks in a single diff parameter
- If you're unsure of the exact content, use read_file first to see the current file
- If the diff was not empty but the operation still failed, re-read the file with read_file and copy the lines from it - never guess or reconstruct from memory.`,
	replaceInFileFileNotFound: `Failed to edit '@REL_PATH@': the file does not exist, so nothing was changed or created.
replace_in_file only edits existing files. Check the path with list_files or search_files, or use write_to_file to create a new file.`,
	diffReminderMatch: `A SEARCH block did not identify exactly one location in the file.
1. Stale context: the file may have changed since you last read it. Re-read it with read_file.
2. Line alignment: each SEARCH line must be a complete file line or its beginning; never start in the middle of a line and never include read_file line labels.
3. Ambiguity: when several locations match, add more leading characters or a distinctive adjacent line.
4. Character confusion: em dash vs hyphen, curly vs straight quotes, tabs vs spaces.
Copy lines from the file instead of reconstructing them from memory. REPLACE must contain complete lines with their exact indentation.`,
	diffReminderFormat: `A SEARCH/REPLACE block is malformed. Every block has this structure, with one delimiter length N >= 7 shared by all of its markers:
------- SEARCH
lines to find
=======
replacement lines
+++++++ REPLACE
- The separator line contains only N equals signs; only the closing marker contains the word REPLACE.
- SEARCH must contain at least one line.
- A longer N is the fix for content lines that look like markers; the separator, the closing marker, and any SKIP marker must then use that same N.
Fix the lines named in the error above and resend the block.`,
	diffReminderOrder: `SEARCH blocks must follow file order and must not overlap. List blocks by ascending line number, and merge blocks that touch the same lines into one block.`,
	diffReminderPartialSuccess: `Blocks reported as success were already applied to the file. Re-read the file and resend only the failed blocks.`,
	diffReminderToolPolicy: `Retry with replace_in_file. Do not edit files with command-line tools; if replace_in_file cannot complete the edit, stop and ask the user.`,
	diffExtraCloseMarker: `Unexpected +++++++ REPLACE close marker without a preceding ------- SEARCH block.
Remove the extra close marker or ensure it follows a complete SEARCH/REPLACE block.`,
	diffNestedSearchMarker: `Nested ------- SEARCH marker found inside SEARCH content.
This usually means the previous SEARCH block was not properly closed.
Ensure each SEARCH/REPLACE block is complete before starting a new one.`,
	diffMissingSeparator: `Missing ======= separator in SEARCH/REPLACE block.
The block has a ------- SEARCH marker and a +++++++ REPLACE marker but no ======= separator.
Add the separator line between the SEARCH content and the REPLACE content.`,
	diffSearchNotFound: `SEARCH content (@LINE_COUNT@) was not found in the file. This block was not applied.
Each SEARCH line must be a complete file line or the beginning of one (leading indentation may be omitted), and SEARCH lines must be consecutive file lines.`,
	diffFindingsHeader: "Findings:",
	diffHintLineLabels: `Every SEARCH line starts with a read_file line label such as "@LABEL@". Labels are not part of the file: remove them from SEARCH and REPLACE.`,
	diffHintSkipDotCount: `SEARCH line @LINE@ "@TEXT@" looks like a SKIP marker, but its dot count differs from the block delimiter, so it was matched as ordinary content. The SKIP marker of this block is "@SKIP_MARKER@".`,
	diffHintEmptyFile: "The file is empty, so no SEARCH line can match. Use write_to_file to write its content.",
	diffHintFirstLineMissing: `SEARCH line 1 "@TEXT@" is not the beginning of any file line.`,
	diffHintBreakPoint: `SEARCH line @LINE@ "@TEXT@" differs from file line @FILE_LINE@ "@FILE_TEXT@"; the SEARCH lines before it match consecutive file lines starting at line @FROM@.`,
	diffHintFileEnds: `SEARCH line @LINE@ "@TEXT@" has no file line left to match; the SEARCH lines before it match from line @FROM@ to the end of the file.`,
	diffSearchAmbiguous: `SEARCH content matches @MATCH_COUNT@ locations in the file (@MATCH_MODE@ match, starting at lines @LINE_NUMBERS@).
Each SEARCH block must match exactly one location. This block was not applied.
Fix: add more leading characters to the SEARCH lines, or include an adjacent line that exists only at the intended location, then retry.`,
	diffSkipTailNotFound: `The SKIP range head matched line @HEAD_LINE@, but no line after it matches the tail (the SEARCH lines after the SKIP marker).
This block was not applied. Re-read the file and make sure the tail lines appear after the head.`,
	diffSkipMarkerFirst: `Invalid SKIP marker: "@SKIP_MARKER@" is the first SEARCH line. A SKIP range needs at least one head line before the marker to anchor where the range starts.`,
	diffSkipMarkerLast: `Invalid SKIP marker: "@SKIP_MARKER@" is the last SEARCH line. A SKIP range needs at least one tail line after the marker to mark where the range ends.`,
	diffSkipMarkerTwice: `Invalid SKIP marker: this block has a second SKIP marker "@SKIP_MARKER@". Use at most one SKIP marker per block, and split the edit into several blocks instead.`,
	diffSkipMarkerInReplace: `Invalid SKIP marker: the REPLACE section contains the SKIP marker "@SKIP_MARKER@". SKIP is only valid in SEARCH; REPLACE is written verbatim, so write every line you want to keep.`,
	diffEmptySearch: `The SEARCH section is empty. SEARCH must contain at least one line of the file to locate the edit.
To write a new file or replace a whole file, use write_to_file.`,
	diffEmptySearchContentConflict: `Empty SEARCH block detected — SEARCH content may conflict with delimiter format.
The SEARCH content line was treated as the ======= separator because it has the same number of characters.
Use a higher delimiter count (>= 7) for all three markers to distinguish content from delimiters.`,
	diffDelimiterTooShort: `Delimiter count @COUNT@ is below the minimum of 7.
Use at least 7 characters for all SEARCH/REPLACE markers. Example:
------- SEARCH
=======
+++++++ REPLACE`,
	diffSearchMarkerInReplace: `Found ------- SEARCH marker inside REPLACE content.
This indicates a malformed SEARCH/REPLACE block — a new SEARCH block started before the previous one was closed.
Close the current block with +++++++ REPLACE before starting a new block.`,
	diffDelimiterConflict: `Delimiter conflict: @BLOCK_TYPE@ content contains a line with @COUNT@ '@CHAR@' characters matching the delimiter.
Use a different delimiter count (e.g. 8 or 9) to avoid this conflict. Example:
-------- SEARCH
========
++++++++ REPLACE`,
	diffDelimiterMismatch: `Delimiter count mismatch: SEARCH marker used @SEARCH_N@ characters but close marker used @CLOSE_N@ characters.
All markers in a block must use the same number of delimiter characters.`,
	diffSeparatorConflict: `Delimiter conflict: this block has more than one line that is exactly @COUNT@ "=" characters. The first one was read as the separator, so a separator-like line in the SEARCH or REPLACE content collides with it.
Keep the content line and use a longer delimiter for every marker of this block, for example:
@SEARCH_MARKER@
@SEPARATOR@
@CLOSE_MARKER@
A SKIP marker in that block needs the same number of dots.`,
	diffSeparatorWithText: `No ======= separator was recognized. SEARCH line @LINE@ "@TEXT@" starts like the separator but has extra text; the separator line must contain only equals signs (@COUNT@ for this block).
Only the closing +++++++ REPLACE marker contains the word REPLACE.`,
	diffMarkerCountMismatch: `Delimiter count mismatch: the block opened with a @OPEN_COUNT@-character SEARCH marker, but @SECTION@ line @LINE@ "@TEXT@" uses @COUNT@ characters, so it was read as content instead of a marker.
All markers of one block (SEARCH, the ======= separator, the closing REPLACE marker, and SKIP) must use the same number of characters.`,
	diffUnclosedSearch: `SEARCH block was not closed — missing ======= separator.
When the diff stream ended, the parser was still inside a SEARCH block.
Ensure every ------- SEARCH is followed by ======= and +++++++ REPLACE.`,
	diffUnclosedReplace: `REPLACE block was not closed — missing +++++++ REPLACE marker.
When the diff stream ended, the parser was still inside a REPLACE block.
Ensure every REPLACE section ends with +++++++ REPLACE.`,
	diffBlockOverlap: `Block #@BLOCK_INDEX@ overlaps with block #@PREV_INDEX@.
SEARCH blocks must be in ascending file position order with no overlapping ranges.
Check that each SEARCH block references content after the previous replacement.`,
	diffBlockOutOfOrder: `Block #@BLOCK_INDEX@ is out of file position order.
SEARCH blocks must match content in the order it appears in the file (ascending line numbers).`,
	diffFinalValidation: `Final validation of the SEARCH/REPLACE diff failed.
The diff structure appears correct but the content cannot be applied to the file.
Re-read the file and verify the exact content of each SEARCH block.`,
}
export default prompts
