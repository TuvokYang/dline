// English system response prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	windsurfRulesWorkspaceInstructions:
		"# .windsurfrules\n\nThe following instructions apply to workspace @WORKSPACE_NAME@.\n\n@CONTENT@",
	cursorRulesWorkspaceFileInstructions:
		"# .cursorrules\n\nThe following instructions apply to workspace @WORKSPACE_NAME@.\n\n@CONTENT@",
	cursorRulesWorkspaceDirInstructions:
		"# .cursor/rules\n\nThe following instructions apply to workspace @WORKSPACE_NAME@.\n\n@CONTENT@",
	agentsRulesWorkspaceInstructions:
		"# AGENTS.md\n\nThe following instructions apply to workspace @WORKSPACE_NAME@. Nested AGENTS.md content is combined below and applies only to files within each rule file's directory scope.\n\n@CONTENT@",
	repeatFileReadNotice:
		"[[NOTE] This file read has been removed to save space in the context window. Refer to the latest file read for the most up to date version of this file.]",
	duplicateFileReadNotice:
		"[[NOTE] This file read has been removed to save space in the context window. Refer to the latest file read for the most up to date version of this file.]",
	contextTruncationNotice:
		"[NOTE] Some previous conversation history with the user has been removed to maintain optimal context window length. The initial user task has been retained for continuity, while intermediate conversation history has been removed. Keep this in mind as you continue assisting the user. Pay special attention to the user's latest messages.",
	continueAssisting: "[Continue assisting the user!]",
	condense: `The user has accepted the condensed conversation summary you generated. This summary covers important details of the historical conversation with the user which has been truncated.\n<explicit_instructions type="condense_response">It's crucial that you respond by ONLY asking the user what you should work on next. You should NOT take any initiative or make any assumptions about continuing with work. For example you should NOT suggest file changes or attempt to read any files.\nWhen asking the user what you should work on next, you can reference information in the summary which was just generated. However, you should NOT reference information outside of what's contained in the summary for this response. Keep this response CONCISE.</explicit_instructions>`,
	fileListTruncated: "(File list truncated. Use list_files on specific subdirectories if you need to explore further.)",
	noFilesFound: "No files found.",

	planModeInstructions: `In this mode you should focus on information gathering, asking questions, and architecting a solution. Once you have a plan, use the make_plan tool to engage in a conversational back and forth with the user. Do not use the make_plan tool until you've gathered all the information you need e.g. with read_file or ask_followup_question.
(Remember: If it seems the user wants you to use tools only available in Act Mode, you should ask the user to "toggle to Act mode" (use those words) - they will have to manually do this themselves with the Plan/Act toggle button below. You do not have the ability to switch to Act Mode yourself, and must wait for the user to do it themselves once they are satisfied with the plan. You also cannot present an option to toggle to Act mode, as this will be something you need to direct the user to do manually themselves.)`,

	fileSizeKb: "@SIZE@ KB",
	fileLineCount: "@COUNT@ lines",
	ordinalSecond: "nd",
	ordinalThird: "rd",
	checkpointRestoreAct:
		"The conversation was restored to a checkpoint. Files may have changed since the checkpoint was created. Continue with the user's edited input below.\n\n<user_message>\n@EDITED_TEXT@\n</user_message>",
	checkpointRestorePlan:
		"The conversation was restored to a checkpoint. Files may have changed since the checkpoint was created. You are in PLAN MODE — respond to the user's edited input below.\n\n<user_message>\n@EDITED_TEXT@\n</user_message>",
	clineIgnoreInstructions:
		"# .agentignore\n\n(The following is provided by a root-level .agentignore file where the user has declared what you may do with each path. A line may end with attributes that remove individual permissions: -r read, -w write, -x run a command there, -s appear in listings and searches. A line with no attributes removes all of them. The rules below are the ones that remove read access; a path listed here cannot be opened, and list_files marks it with @LOCK_SYMBOL@. Paths hidden only from listings are still readable by exact path.)\n\n@CONTENT@\n.agentignore",
	clineRulesGlobalDirInstructions:
		"# Global User Rules\n\nThe following is provided by global user rules where the user has specified instructions for all working directories:\n\n@CONTENT@",
	clineRulesLocalDirInstructions:
		"# Local User Rules (.agents/rules/)\n\nThe following is provided by local user rules in @WORKSPACE_NAME@ where the user has specified instructions:\n\n@CONTENT@",
	clineRulesLocalFileInstructions:
		"# Local User Rules (.agents/rules)\n\nThe following is provided by local user rules in @WORKSPACE_NAME@ where the user has specified instructions:\n\n@CONTENT@",
}

export default prompts
