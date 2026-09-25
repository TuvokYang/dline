// English context management prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	summarizeMain: `<explicit_instructions type="summarize_task">
@COMPACTION_WINDOW_BUDGET@The current conversation is rapidly running out of context. Now, your urgent task is to create a comprehensive detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

@SUMMARY_DECISION@

You must respond to this message by calling the summarize_task tool. Do not call attempt_completion or any other tool. Include ALL information in the summary required for continuing with the task at hand. This is because you will lose access to all messages other than this summary.

When responding with the summarize_task tool call, follow these instructions:

- Stop adding optional detail as the recommended upper bound or hard limit is approached.
- Emit exactly one syntactically complete summarize_task call.
- Close </context></summarize_task> before the hard limit; reserve that closing payload before adding optional detail.
- Do not emit an additional empty <summarize_task /> call.

Before providing your final summary, thoroughly analyze the conversation to ensure you've covered all necessary points. In your analysis process:
1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits, etc
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:
1. Previous Conversation: High level details about what was discussed throughout the entire conversation with the user. This should be written to allow someone to be able to follow the general overarching conversation flow.
2. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
3. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
4. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
7. Task Evolution: If the user provided additional requests or modified the original task during the conversation, document this progression:
   - Original Task: [Summary of the initial user request, including copying verbatim any relevant information/steps required to continue working]
   - Task Modifications: [Chronological list of how the user redirected or modified the work since the original task]
   - Current Active Task: [What the user most recently asked to work on]
   - Context for Changes: [Why the task evolved - user feedback, new requirements, etc. (Include direct quotes from user messages that caused task changes to prevent drift after context compacting)]
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests without confirming with the user first.
                     If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.
10. Required Files: List the most important files needed for continuing the work you laid out in Next Step. This is optional and if no files are required or there is no next step then simply don't include this section. List each file path on a new line starting with "- " such as: - src/main.js. List the files from most important to least important. You must list the minimum number of files necessary to continue with the task.
                     Only list files you know will for sure be necessary, rather than speculating. @WORKSPACE_PATH_RULE@
11. You should pay special attention to the most recent user message, as it indicates the user's most recent intent.

@FOCUS_CHAIN_PARAM@

Usage:
<summarize_task>
<context>Your detailed summary</context>
@FOCUS_CHAIN_USAGE@
</summarize_task>

Here's an example of how your output should be structured:

<example>
<summarize_task>
<context>
1. Previous Conversation:
   [High level overview of the entire conversation flow]
2. Primary Request and Intent:
   [Detailed description]
3. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]
4. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]
5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]
6. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]
7. Task Evolution:
   - Original Task: [Initial request summary]
   - Task Modifications:
     1. [Modification 1]
     2. [Modification 2]
   - Current Active Task: [Most recent task]
   - Context for Changes: [Why it evolved]
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
There is an optional task_progress parameter. If a checklist exists, report the exact completed items that represent the current progress, followed by the subsequent items that still need to be completed, preserving their order from the existing checklist. Use \`- [x]\` for completed items and \`- [ ]\` for the remaining items. The first \`- [ ]\` item identifies the current work after continuation; later \`- [ ]\` items preserve the remaining execution order. Do not send the full checklist, title, or section headings. If no task_progress list was included in the previous context, do not create a new one.`,

	summarizeFocusChainUsage: `<task_progress>ordered completed and remaining checklist items</task_progress>`,

	summarizeFocusChainExample: `<task_progress>
- [x] Trace refresh-token failure
- [x] Correct refresh retry state
- [ ] Verify expired-session recovery
- [ ] Verify explicit logout behavior
</task_progress>`,

	summarizeDecisionWithFocus:
		"You must call the summarize_task tool whether you are in PLAN or ACT mode, regardless of whether prior work or every task_progress item appears complete. Do not call attempt_completion. Treat the latest user-authored input as authoritative context that must be preserved in the summary and subsequent continuation.",

	summarizeDecisionWithoutFocus:
		"You must call the summarize_task tool whether you are in PLAN or ACT mode, even if prior work appears complete. Do not call attempt_completion. Treat the latest user-authored input as authoritative context that must be preserved in the summary and subsequent continuation.",

	summarizeToolDescription:
		"The current conversation is rapidly running out of context. Now, your urgent task is to create a comprehensive detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",

	summarizeContextInstruction:
		"This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.",

	continuationPrompt: `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:
@SUMMARY_TEXT@.

Please continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on. Pay special attention to the most recent user message when responding rather than the initial task message, if applicable.
If the most recent user's message starts with "/newtask", "/smol", "/compact", "/newrule", or "/reportbug", you should indicate to the user that they will need to run this command again.`,

	raceConditionToolError: `This tool call was not approved by the user and was triggered by a race condition during mode switching. The client has already executed this tool call, but the result is indeterminate (it may have succeeded, failed, or been cancelled). Please verify the workspace state before continuing.`,
}

export default prompts
