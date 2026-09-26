// English tool handler error/prompt messages — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	toolDenied: "The user denied this operation.",
	toolError: "The tool execution failed with the following error:\n<error>\n@ERROR@\n</error>",
	noToolsUsed: `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.

@TOOL_REMINDER@

# Next Steps

If the previous response was intended as a non-blocking user-visible message and execution should continue, resend it with \`act_mode_respond\` in ACT MODE or \`status_update\` with acknowledgment disabled, then follow it with an actual work tool in the same turn.
If the user asked a question or requested clarification and your response should hand control back to the user, answer with the TURN-END \`qna_respond\` tool.
If the entire user task is complete after comparing the result with the latest request and Objective, use \`attempt_completion\`. A completed phase checklist alone is not enough.
If progress requires information or a decision only the user can provide, use \`ask_followup_question\`.
Otherwise, continue with the next non-turn-ending work step. Do not use a progress summary, intermediate milestone, automatic compaction, or context pressure as a reason to finish.
(This is an automated message. Follow the applicable tool path above rather than replying in plain text.)`,
	tooManyMistakes:
		"You seem to be having trouble proceeding. The user has provided the following feedback to help guide you:\n<feedback>\n@FEEDBACK@\n</feedback>",
	missingToolParameterError:
		"Missing value for required parameter '@PARAM_NAME@'. Please retry with complete response.\n\n@TOOL_REMINDER@",
	toolAlreadyUsed:
		"Tool [@TOOL_NAME@] was not executed because a tool has already been used in this message. Only one tool may be used per message. You must assess the first tool's result before proceeding to use the next tool.",
	repeatedToolCall:
		"Tool [@TOOL_NAME@] has been called @COUNT@ times consecutively with identical arguments. This is not making progress. Please use a different tool or different arguments instead of repeating the same call.",
	toolUseInstructionsReminder: `# Reminder: Instructions for Tool Use
Tool uses are formatted using XML-style tags. The tool name is enclosed in opening and closing tags, and each parameter is similarly enclosed within its own set of tags. Here's the structure:
<tool_name>
<parameter1_name>value1</parameter1_name>
<parameter2_name>value2</parameter2_name>
...
</tool_name>
For example:
<attempt_completion>
<result>
I have completed the task...
</result>
</attempt_completion>
Always adhere to this format for all tool uses to ensure proper parsing and execution.`,

	// AttemptCompletionHandler
	doubleCheckVerification:
		"Before completing, compare the current result with the original task and the latest user instructions again. Consider:\n" +
		"1. Whether the user-visible outcome and expected deliverables are complete\n" +
		"2. Whether the completed checklist covered the full Objective or only one phase\n" +
		"3. Whether any work discovered during execution still needs attention\n" +
		"4. Whether the relevant verification supports the claims you plan to make\n" +
		"5. Whether known failures, skipped checks, blockers, limitations, or remaining risks are stated honestly\n" +
		"6. Whether the final result will be easy to scan without forcing a fixed heading template" +
		"@TASK_SECTION@" +
		"\n\nIf work still remains, continue the task and create the next checklist when the current phase is complete. If the entire task is complete, call attempt_completion again with a clear, readable result that does not hide known problems or unverified claims.",

	attemptCompletionNotificationSubtitle: "Task Completed",

	// AskFollowupQuestionToolHandler
	yoloAutoRespond: '[YOLO MODE] Auto-responding to question: "@QUESTION@"',
	yoloToolResult:
		'[YOLO MODE: User input is not available in non-interactive mode. You must use available tools (read_file, list_files, search_files, etc.) to gather the information you need instead of asking the user. Proceed with using tools to find the answer to your question: "@QUESTION@"]',
	askFollowupNotificationSubtitle: "Dline has a question...",

	// MakePlanHandler
	planNeedsMoreExploration:
		"[You have indicated that you need more exploration. Proceed with calling tools to continue the planning process.]",
	planYoloAutoExecute: "[Go ahead and execute.]",
	planYoloSwitchToAct: "[The user has switched to ACT MODE, so you may now proceed with the task.]",
	planYoloSwitchFailed: "YOLO MODE: Failed to switch to ACT MODE, continuing with normal plan mode",

	// GenerateExplanationToolHandler
	generateExplanationApiNotAvailable: "API configuration not available",
	generateExplanationNoChanges: "No changes found between '@FROM_REF@' and '@TO_REF@'.",
	generateExplanationCancelled: "Explanation generation was cancelled.",

	// SubagentToolHandler
	subagentsDisabled: "Subagents are disabled. Enable them in Settings > Features to use this tool.",

	// WebFetchToolHandler
	webToolsDisabled: "Dline web tools are currently disabled.",
	webFetchNotRoutedLocally:
		"Dline local web_fetch is not available for this request. Web Fetch is provider-hosted or unavailable under the current Web Tools mode.",

	// WebSearchToolHandler
	webSearchDisabled: "Dline web tools are currently disabled.",
	webSearchDomainConflict: "Cannot specify both allowed_domains and blocked_domains",

	// MakePlanHandler (non-yolo mode switch)
	planSwitchToAct: "[The user has switched to ACT MODE, so you may now proceed with the task.]",
	planSwitchToActWithMessage:
		"[The user has switched to ACT MODE, so you may now proceed with the task.]\n\nThe user also provided the following message when switching to ACT MODE:\n<user_message>\n@TEXT@\n</user_message>",

	// ApplyPatchHandler
	patchDenied: "The user denied this patch operation.",
	patchSuccess: "Successfully applied patch to the following files:",
	patchInvalidSentinels: "Invalid patch text - incomplete sentinels. Try breaking it into smaller patches.",

	// SpawnTaskHandler
	spawnTaskFailed:
		"Spawn task failed: unable to access extension context from parent task. The parent task must have an active controller context.",

	// SearchFilesToolHandler
	searchNoResults: "Found 0 results.",
	searchAgentRestricted:
		"Search refused: '@PATH@' is restricted by '.agentignore'. This is a permission set by the workspace, not a performance exclusion, so it is not lifted by naming the path directly. Do not attempt to read or search it through the terminal or any other tool.",

	// SummarizeTaskHandler
	contextCompactionCancelled: "Context compaction was cancelled. Task has been aborted.",

	// NewTaskHandler
	newTaskCreated: "The user has created a new task with the provided context.",

	// SubagentToolHandler
	subagentExecutionFailed: "Subagent execution failed",
	subagentRetryablePaused:
		"Subagent '@SUBAGENT@' stopped without producing a result (@REASON@). The activity and its accumulated context are preserved. Tell the user they can restart it with the Retry control on the subagent activity, then continue with the remaining work. Do not treat this as a completed result and do not silently re-run the same subagent. Job: @JOB_ID@",
	subagentBatchRetryablePaused:
		"@COUNT@ of @TOTAL@ subagents stopped without producing a result and are preserved for retry. Tell the user they can restart each one with the Retry control on its activity. Do not treat these as completed results.",

	// WriteToFileToolHandler
	writeToFileRetrying: "Retrying...",
	writeToFileApproachChange: "This has happened multiple times — Dline will try a different approach.",
	writeToFileNotUpdated: "The file was not updated, and maintains its original contents.",
	writeToFileNotCreated: "The file was not created.",
}

export default prompts
