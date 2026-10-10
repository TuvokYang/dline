// English prompts - key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    standardDescription:
        "Terminate one currently running command started by execute_command. Use the exact function_id reported by the running execute_command result. This only targets the command owned by that tool call and does not cancel the task or other commands.",
    standardFunctionIdInstruction:
        "The exact function_id reported by the still-running execute_command result. Do not pass a command activity ID, terminal ID, shell process ID, or the function_id of the kill_command call itself.",
    unavailableError: "Command termination is unavailable in the current task runtime.",
    terminationRequested: "Termination was requested for the running command.",
    notRunning: "No running command was found for that function_id; it may have already exited or been terminated.",
}
export default prompts
