// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description: `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Commands default to the task's default workspace. Use workdirectory when a command must run elsewhere instead of prepending a cd command.`,
	commandInstruction:
		"The CLI command to execute. Write it in the syntax of the shell reported under SYSTEM INFORMATION, not in whichever shell syntax comes to mind first: heredocs, piping into text filters, conditional chaining, inline environment variables and quoting all differ between shells, and a mismatch fails outright rather than degrading. Ensure the command is properly formatted and does not contain any harmful instructions.",
	commandUsage: "Your command here",
	workdirectoryInstruction:
		"Optional directory in which to execute the command. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@ The directory must already exist. Directories outside the project require user approval. Use this parameter instead of prepending cd solely to change the command directory.",
	workdirectoryUsage: "path/to/directory",
	requiresApprovalInstruction:
		"A boolean indicating whether this command requires explicit user approval before execution in case the user has auto-approve mode enabled. Set to 'true' for potentially impactful operations like installing/uninstalling packages, deleting/overwriting files, system configuration changes, network operations, or any commands that could have unintended side effects. Set to 'false' for safe operations like reading files/directories, running development servers, building projects, and other non-destructive operations.",
	requiresApprovalUsage: "true or false",
	backgroundInstruction:
		"Optional boolean. Set true to start the command as a Dline-owned background process, return control immediately, and keep its output and cancellation lifecycle tracked. Defaults to false.",
	backgroundUsage: "false",
	timeoutInstruction:
		"Optional timeout in seconds. Use a positive integer to terminate the command after that many seconds, or any integer less than or equal to zero to allow it to run indefinitely. A command without a timeout remains cancellable.",
	timeoutUsage: "30",
	muteStdoutInstruction:
		"Optional boolean. When true, successful stdout is omitted from the tool result returned to you and only the successful exit status is returned. Failures still return captured diagnostics and the error code. This can save context tokens, but use it only when you are certain stdout is unnecessary. If you are unsure whether stdout is needed, omit this parameter or set it to false. The user interface, Activities, and command logs still retain the output.",
	muteStdoutUsage: "false",
	standardDescription: `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Commands default to the current workspace; set workdirectory when a command must run elsewhere.`,
	standardCommandInstruction:
		"The CLI command to execute. Write it in the syntax of the shell reported under SYSTEM INFORMATION, not in whichever shell syntax comes to mind first: heredocs, piping into text filters, conditional chaining, inline environment variables and quoting all differ between shells, and a mismatch fails outright rather than degrading. When a command fails on syntax, re-check it against the reported shell before retrying. Ensure the command is properly formatted and does not contain any harmful instructions. Do not use the ~ character or $HOME to refer to the home directory. Do not prepend cd solely to select the execution directory; use workdirectory instead.",
	standardWorkdirectoryInstruction:
		"Optional directory in which to execute the command. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@ The directory must already exist. A directory outside every project root requires user approval.",
	standardRequiresApprovalInstruction:
		"A boolean indicating whether this command requires explicit user approval before execution in case the user has auto-approve mode enabled. Set to true for potentially impactful operations like installing or uninstalling packages, deleting or overwriting files, system configuration changes, network operations, or any commands that could have unintended side effects. Set to false for safe operations like reading files or directories, running development servers, building projects, and other non-destructive operations.",
	standardBackgroundInstruction:
		"Optional boolean. Set true to start the command immediately as a Dline-owned background process, return control immediately, and keep its output and cancellation lifecycle tracked. The result includes the function_id required to terminate that process later with kill_command. This takes precedence over synchronous. Defaults to false.",
	standardSynchronousInstruction:
		"Optional boolean. Set true to keep the command in the foreground beyond the default 10-second background handoff, waiting until the process exits or its timeout terminates it. Defaults to false. Ignored when background is true.",
	standardTimeoutInstruction:
		"Optional integer timeout in seconds. Use a positive integer as the command's absolute maximum runtime from actual process start; reaching it terminates the process. Set to zero or a negative integer to allow the command to run indefinitely without a deadline; it remains cancellable. If omitted, default is @TERMINAL_COMMAND_TIMEOUT_SECONDS@ seconds. By default, a command still running at the 10-second background handoff continues as the same tracked background process without resetting this timeout.",
	standardMuteStdoutInstruction:
		"Optional boolean. Set true only when you are certain the command's stdout is not needed for any later reasoning or action. After a successful exit, Dline omits stdout from the tool result returned to you and returns only the successful exit status, which can save context tokens. On failure, Dline still returns captured diagnostics and the error code. The user interface, Activities, and command logs retain the full output. If you are unsure whether stdout is needed, omit this parameter or set false.",
	clineIgnoreError:
		"Access to @PATH@ is blocked by the .agentignore file settings. You must try to continue in the task without using this file, or ask the user to update the .agentignore file.",
	permissionDeniedError:
		"Command execution blocked by DLINE_COMMAND_PERMISSIONS: @REASON@. You must try a different approach or ask the user to update the permission settings.",
	executeCommandMissingCommandError: `The 'command' parameter was empty. Provide the shell command to execute.

Example:
<execute_command>
<command>python -m pytest tests/</command>
<workdirectory>/path</workdirectory>
<requires_approval>false</requires_approval>
</execute_command>`,
}
export default prompts
