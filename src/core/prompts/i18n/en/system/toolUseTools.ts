// English tool use tools section prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
    taskProgressParam:
        "- task_progress: (optional) A checklist showing task progress after this tool use is completed. (See 'Updating Task Progress' section for more details)\n",

    focusChainAttempt:
        "If you were using task_progress to update the task progress, you must include the completed list in the result as well.\n",

    focusChainUsage: `<task_progress>
Checklist here (optional)
</task_progress>\n`,
}

export default prompts
