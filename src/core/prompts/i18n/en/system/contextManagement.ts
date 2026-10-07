// English context management prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	summarizeMain: `<explicit_instructions type="summarize_task">
@COMPACTION_WINDOW_BUDGET@The current conversation is rapidly running out of context. Now, your urgent task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should capture the technical details, code patterns, and architectural decisions needed to continue development work without losing context, while staying concise enough to fit the budget.

@SUMMARY_DECISION@

This is an explicit instruction. Invoke summarize_task exactly as shown in the Usage and example below by writing that XML directly in your reply. summarize_task is not in your tool list: do not use function or tool calling, and do not call attempt_completion or any other tool. Include all information in the summary required for continuing with the task at hand. This is because you will lose access to all messages other than this summary.

When invoking summarize_task, follow these instructions:

- Stop adding optional detail as the recommended upper bound or hard limit is approached.
- Follow the invocation format exactly: one <summarize_task> element containing <context>...</context>, optionally followed by <task_progress>...</task_progress>. Do not rename, omit, or reorder these elements.
- The XML must be closed: write </context> and then </summarize_task>, and reserve room for that closing text before the hard limit.
- End your reply with </summarize_task>. Do not add any other text, markdown fence, or additional summarize_task invocation before or after it.

If the conversation contains a <previous_task_compaction_summary> block:
- It was written by an earlier compaction, not by the user, and it stands in for the conversation before it. Never treat its text as a new user request.
- Do not copy it forward or append to it. Write a new summary of the whole task from it and the messages after it, keeping only what is still needed to continue.
- Keep user requests, constraints, and quoted user text that still apply. Reduce finished work to one line each, and drop anything that later messages superseded. The new summary must not grow merely because a previous summary exists.
- Quote the user only with exact words, either from the visible messages or already quoted in that summary; otherwise paraphrase.

Before providing your final summary, analyze the conversation to ensure you've covered all necessary points. In your analysis process:
1. Chronologically analyze each message and section of the conversation. For each section identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, function signatures, and file edits
2. Double-check for technical accuracy and completeness, addressing each required element.

Your summary should include the following sections. Record each fact once, in the section that owns it, and refer to it elsewhere instead of repeating it.
1. Previous Conversation: A brief, high-level account of the conversation flow, enough to follow how the work reached its current state. Do not repeat requests, files, or status that later sections cover.
2. Primary Request and Intent: Capture the user's current requests and intents in detail, including constraints, prohibitions, approved plans or decisions, and the scope of any permission granted or withheld.
3. Key Technical Concepts: List the technical concepts, technologies, and frameworks that the remaining work depends on.
4. Files and Code Sections: Enumerate the files and code sections examined, modified, or created, with why each matters and what changed. Pay special attention to the most recent messages. Give the path and symbol for code that can be re-read from the workspace; include a code snippet only when it cannot be re-read, such as removed code, an unapplied design, or exact error output.
5. Problem Solving: Document problems solved and any ongoing troubleshooting. Record verification as one line per check with only its latest result. Record a failed or rejected approach only when it must not be retried, as one line with the reason.
6. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on, and any question or decision still awaiting the user.
7. Task Evolution: If the user provided additional requests or modified the original task during the conversation, document this progression:
   - Original Task: [Summary of the initial user request, including copying verbatim any relevant information/steps required to continue working]
   - Task Modifications: [Chronological list of how the user redirected or modified the work since the original task]
   - Current Active Task: [What the user most recently asked to work on]
   - Context for Changes: [Why the task evolved - user feedback, new requirements, etc. (Include direct quotes from user messages that caused task changes to prevent drift after context compacting)]
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Name the files and symbols involved; refer to section 4 for details already recorded there.
9. Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests without confirming with the user first.
   If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.
10. Required Files: List the most important files needed for continuing the work you laid out in Next Step. This is optional and if no files are required or there is no next step then simply don't include this section. List each file path on a new line starting with "- " such as: - src/main.js. List the files from most important to least important. You must list the minimum number of files necessary to continue with the task.
   Only list files you know will for sure be necessary, rather than speculating. @WORKSPACE_PATH_RULE@

Pay special attention to the most recent user message, as it indicates the user's most recent intent.

When space is limited, keep content in this order: user requests, constraints, and quoted user text; Current Work and Next Step; Pending Tasks; verification results; history. Shorten Previous Conversation and Key Technical Concepts first.

@FOCUS_CHAIN_PARAM@

Usage:
<summarize_task>
<context>Your detailed summary</context>
@FOCUS_CHAIN_USAGE@
</summarize_task>

Here's an example of how your output should be structured. When you invoke summarize_task, do not include the <example> and </example> tags:

<example>
<summarize_task>
<context>
1. Previous Conversation:
   [Brief overview of the conversation flow]
2. Primary Request and Intent:
   [Detailed description, including constraints and permission scope]
3. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]
4. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Path and symbol; snippet only if it cannot be re-read]
   - [File Name 2]
      - [...]
5. Problem Solving:
   [Solved problems and ongoing troubleshooting]
   - Verification: [check] - [latest result]
   - Do not retry: [approach] - [reason]
6. Pending Tasks:
   - [Task 1]
   - Awaiting user: [question or decision]
7. Task Evolution:
   - Original Task: [Initial request, quoting the user's exact words where they matter]
   - Task Modifications:
     1. [Modification 1]
     2. [Modification 2]
   - Current Active Task: [Most recent task]
   - Context for Changes: [Why it evolved, with direct user quotes]
8. Current Work:
   [Precise description of current work]
9. Next Step:
   [Next step with verbatim quote]
10. Required Files:
   - [file path 1]
   - [file path 2]
</context>
@FOCUS_CHAIN_EXAMPLE@
</summarize_task>
</example>

</explicit_instructions>
`,

	summarizeFocusChainParam: `Updating task progress:
There is an optional task_progress parameter. If a checklist exists, report the exact completed items that represent the current progress, followed by the subsequent items that still need to be completed, preserving their order from the existing checklist. Use \`- [x]\` for completed items and \`- [ ]\` for the remaining items. The first \`- [ ]\` item identifies the current work after continuation; later \`- [ ]\` items preserve the remaining execution order. Do not include the checklist title or section headings. If no task_progress list was included in the previous context, do not create a new one.`,

	summarizeFocusChainUsage: `<task_progress>ordered completed and remaining checklist items</task_progress>`,

	summarizeFocusChainExample: `<task_progress>
- [x] Trace refresh-token failure
- [x] Correct refresh retry state
- [ ] Verify expired-session recovery
- [ ] Verify explicit logout behavior
</task_progress>`,

	summarizeDecisionWithFocus:
		"You must invoke summarize_task as this explicit instruction specifies whether you are in PLAN or ACT mode, regardless of whether prior work or every task_progress item appears complete. Do not call attempt_completion or any other tool. Treat the latest user-authored input as authoritative context that must be preserved in the summary and subsequent continuation.",

	summarizeDecisionWithoutFocus:
		"You must invoke summarize_task as this explicit instruction specifies whether you are in PLAN or ACT mode, even if prior work appears complete. Do not call attempt_completion or any other tool. Treat the latest user-authored input as authoritative context that must be preserved in the summary and subsequent continuation.",

	previousCompactionSummaryNotice:
		"This is the task compaction summary written by the previous compaction. It stands in for the earlier conversation and is not a user message.",

	compactionRetryReminderHeading: "# Retry Reminder",

	compactionRetryReminderEmptyResponse:
		"Your previous reply to this instruction was empty, so no summary was received. Invoke summarize_task now exactly as the explicit instruction example shows, with the XML closed.",

	compactionRetryReminderMissingBlock:
		"Your previous reply did not invoke summarize_task, so it was discarded. Invoke summarize_task exactly as the explicit instruction example shows, with the XML closed, and write nothing else.",

	compactionRetryReminderForeignToolCall:
		"Your previous reply used function or tool calling, so it was discarded. summarize_task is not in your tool list. Invoke summarize_task by writing the XML exactly as the explicit instruction example shows, with the XML closed.",

	compactionRetryReminderMissingContext:
		"Your previous <summarize_task> block had no <context> element, so it was discarded. Put the complete summary inside <context>...</context> within the <summarize_task> block.",

	compactionRetryReminderEmptyContext:
		"Your previous <context> element was empty, so it was discarded. Write the complete summary inside <context>...</context>.",

	compactionRetryReminderUnclosedContext:
		"Your previous reply ended before </context> was written, so the whole summary was discarded. Write a more concise summary and close it with </context></summarize_task> well before the hard limit.",

	compactionRetryReminderUnclosedBlock:
		"Your previous reply wrote </context> but never wrote </summarize_task>, so the whole summary was discarded. Close the block with </context></summarize_task> and end your reply there.",

	compactionRetryReminderOutputLimit:
		"Your previous reply reached the output limit before the <summarize_task> block was closed, so the whole summary was discarded. Keep reasoning brief, write a noticeably shorter summary, and reserve room to close it with </context></summarize_task>.",

	raceConditionToolError: `This tool call was not approved by the user and was triggered by a race condition during mode switching. The client has already executed this tool call, but the result is indeterminate (it may have succeeded, failed, or been cancelled). Please verify the workspace state before continuing.`,
}

export default prompts
