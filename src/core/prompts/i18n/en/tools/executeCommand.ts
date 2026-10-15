// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Request to execute a CLI command on the system. Use this when you need to perform system operations or run commands required by the user's task. Tailor the command to the reported shell and explain what it does. Use the shell's correct chaining syntax. Prefer executing a direct command over creating an executable script. Commands run in the task's default workspace unless workdirectory is set. Command output is streamed in real time, so keep stdout and stderr intact by default. Filter only when necessary, preferably with command-native stdout, stderr, log-level, quiet, error-only, failure-only, selector, or reporter options that preserve the real exit code and useful diagnostics.`,
    commandInstruction:
        "The CLI command to execute. Write it in the syntax of the shell reported under SYSTEM INFORMATION. Heredocs, pipelines, conditional chaining, inline environment variables, and quoting differ between shells; mismatched syntax fails rather than degrading. Ensure the command is properly formatted and does not contain harmful instructions.",
    commandUsage: "Your command here",
    workdirectoryInstruction:
        "Optional directory in which to execute the command. Omit this parameter to use the default workspace. Otherwise pass a relative directory path.@MULTI_ROOT_HINT@ The directory must already exist. Directories outside the project require user approval. Use this parameter instead of prepending cd solely to change the command directory.",
    workdirectoryUsage: "path/to/directory",
    requiresApprovalInstruction:
        "A boolean indicating whether this command requires explicit user approval before execution when auto-approve is enabled. Set to true for potentially impactful operations such as installing or uninstalling packages, deleting or overwriting files, changing system configuration, performing network operations, or running commands with other unintended side effects. Set to false for safe operations such as reading files or directories, running development servers, and building projects, or for a series of non-dangerous operations that the user has explicitly authorized.",
    requiresApprovalUsage: "true or false",
    backgroundInstruction:
        "Optional boolean. Set true to start the command in the background and return control after startup. Background output is stored automatically in the log file reported for the process, so redirecting output solely to create a log is unnecessary. Defaults to false.",
    backgroundUsage: "false",
    timeoutInstruction:
        "Optional timeout in seconds. Use a positive integer to terminate the command after that many seconds. Use zero or a negative integer to allow it to run indefinitely. A command without a deadline remains cancellable.",
    timeoutUsage: "30",
    muteStdoutInstruction:
        "Optional boolean. Set true only when successful stdout is not needed for later reasoning or action. After a successful exit, stdout is omitted from the tool result and only the success status is returned. On failure, captured diagnostics are still returned. If unsure, omit this parameter or set false.",
    muteStdoutUsage: "false",
    standardDescription: `Request to execute a CLI command on the system. Use this when you need to perform system operations or run commands required by the user's task. Tailor the command to the reported shell and explain what it does. Use the shell's correct chaining syntax. Prefer executing a direct command over creating an executable script. Commands run in the current workspace unless workdirectory is set. Command output is streamed in real time, so keep stdout and stderr intact by default. Filter only when necessary, preferably with command-native stdout, stderr, log-level, quiet, error-only, failure-only, selector, or reporter options that preserve the real exit code and useful diagnostics.`,
    standardCommandInstruction:
        "The CLI command to execute. Write it in the syntax of the shell reported under SYSTEM INFORMATION. Heredocs, pipelines, conditional chaining, inline environment variables, and quoting differ between shells; mismatched syntax fails rather than degrading. When a command fails on syntax, re-check it against the reported shell before retrying. Ensure the command is properly formatted and does not contain harmful instructions. Do not use ~ or $HOME to refer to the home directory. Do not prepend cd solely to select the execution directory; use workdirectory instead.",
    standardWorkdirectoryInstruction:
        "Optional directory in which to execute the command. Omit this parameter to use the default workspace. Otherwise pass a relative directory path.@MULTI_ROOT_HINT@ The directory must already exist. A directory outside every project root requires user approval.",
    standardRequiresApprovalInstruction:
        "A boolean indicating whether this command requires explicit user approval before execution when auto-approve is enabled. Set to true for potentially impactful operations such as installing or uninstalling packages, deleting or overwriting files, changing system configuration, performing network operations, or running commands with other unintended side effects. Set to false for safe operations such as reading files or directories, running development servers, and building projects, or for a series of non-dangerous operations that the user has explicitly authorized.",
    standardBackgroundInstruction:
        "Optional boolean. Set true to start the command immediately in the background and return control after startup. Background output is stored automatically in the log file reported for the process, so redirecting output solely to create a log is unnecessary. The result includes the function_id required to terminate the process later with kill_command. This takes precedence over synchronous. Defaults to false.",
    standardSynchronousInstruction:
        "Optional boolean. Set true to keep the command in the foreground beyond the default 10-second background handoff, waiting until the process exits or its timeout terminates it. Defaults to false. Ignored when background is true.",
    standardTimeoutInstruction:
        "Optional integer timeout in seconds. Use a positive integer as the command's absolute maximum runtime from actual process start; reaching it terminates the process. Use zero or a negative integer to allow it to run indefinitely without a deadline; it remains cancellable. If omitted, the default is @TERMINAL_COMMAND_TIMEOUT_SECONDS@ seconds. A command that reaches the default 10-second background handoff continues as the same process without resetting this timeout.",
    standardMuteStdoutInstruction:
        "Optional boolean. Set true only when successful stdout is not needed for later reasoning or action. After a successful exit, stdout is omitted from the tool result and only the success status is returned. On failure, captured diagnostics are still returned. If unsure, omit this parameter or set false.",
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
