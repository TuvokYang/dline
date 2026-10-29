import { createRuntimeContract } from "../../helpers/create-contract"
import { defineLegacyModule } from "../../helpers/define-legacy-module"
import commands from "./commands"
import deepPlanning5Step from "./deep-planning-5-step"
import deepPlanningGeneric from "./deep-planning-generic"

export const commandPromptModules = [
    defineLegacyModule("commands", "commands", commands, {
        newTaskMain: createRuntimeContract("TOOL_CALL_FORMAT"),
        newRuleToolResponse: createRuntimeContract("TOOL_CALL_FORMAT"),
        reportBugToolResponse: createRuntimeContract("TOOL_CALL_FORMAT"),
        explainChangesToolResponse: createRuntimeContract("TOOL_CALL_FORMAT"),
    }),
    defineLegacyModule("deepPlanning5Step", "commands", deepPlanning5Step, {
        main: createRuntimeContract(
            "FOCUS_CHAIN_NOTE",
            "SHELL_COMMANDS",
            "FOCUS_CHAIN_TASK_PROGRESS_LINE",
            "FOCUS_CHAIN_TASK_NOTE",
            "FOCUS_CHAIN_TASK_PROGRESS",
            "TOOL_DEFINITION",
        ),
    }),
    defineLegacyModule("deepPlanningGeneric", "commands", deepPlanningGeneric, {
        main: createRuntimeContract("SHELL_COMMANDS", "NAV_COMMANDS", "FOCUS_CHAIN_PARAM", "NEW_TASK_INSTRUCTIONS"),
    }),
] as const
