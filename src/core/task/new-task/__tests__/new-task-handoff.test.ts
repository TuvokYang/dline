import type { Mode } from "@shared/storage/types"
import { describe, expect, it } from "vitest"
import type { StartSuccessorTaskPostCommitDirective } from "../../tools/ToolExecutionResult"
import { createNewTaskHandoff, type NewTaskSettingsSource } from "../new-task-handoff"

interface StableProfileSettingsSource extends NewTaskSettingsSource {
    readonly planModeProfileId: string
    readonly actModeProfileId: string
}

describe("createNewTaskHandoff Profile identity", () => {
    it("inherits stable Profile IDs together with the display names", () => {
        const directive: StartSuccessorTaskPostCommitDirective = {
            type: "start_successor_task",
            task: "Finish the isolated task",
            context: "Continue the isolated task",
            functionId: "function-new-task",
            dlineTid: "tid-new-task",
        }
        const source: StableProfileSettingsSource = {
            mode: "act" as Mode,
            planModeProfileId: "plan-profile-id",
            planModeProfile: "plan-profile",
            actModeProfileId: "act-profile-id",
            actModeProfile: "act-profile",
        }

        const handoff = createNewTaskHandoff(directive, source)

        expect(handoff).toMatchObject({ task: "Finish the isolated task", context: "Continue the isolated task" })
        expect(handoff.taskSettings).toMatchObject({
            mode: "act",
            planModeProfileId: "plan-profile-id",
            planModeProfile: "plan-profile",
            actModeProfileId: "act-profile-id",
            actModeProfile: "act-profile",
        })
    })
})
