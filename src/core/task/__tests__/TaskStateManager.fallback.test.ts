import { afterEach, beforeEach, describe, it } from "vitest"
import "should"
import { createStorageContext } from "@shared/storage/storage-context"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { StateManager } from "@/core/storage/StateManager"
import { TaskStateManager } from "../TaskStateManager"

describe("TaskStateManager - Global Settings Fallback", () => {
    let tempDir: string
    let sm: StateManager

    beforeEach(async () => {
        tempDir = path.join(os.tmpdir(), `tsm-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await fs.mkdir(tempDir, { recursive: true })
        const storageCtx = createStorageContext({ clineDir: tempDir })
        sm = await StateManager.initialize(storageCtx)
    })

    afterEach(async () => {
        await StateManager.resetForTest()
        try {
            await fs.rm(tempDir, { recursive: true, force: true })
        } catch {
            /* ignore */
        }
    })

    it("should return undefined for new task profiles, allowing fallback to global settings", () => {
        // Simulate global profile settings
        sm.setGlobalState("planModeProfile" as any, "global-plan-profile")
        sm.setGlobalState("actModeProfile" as any, "global-act-profile")

        // Create a new task without setting task-level profiles
        const taskSm = new TaskStateManager("new-task", sm)

        // Task-level profiles should be undefined
        ;(taskSm.planModeProfile === undefined).should.be.true()
        ;(taskSm.actModeProfile === undefined).should.be.true()

        // This allows Controller.getStateToPostToWebview() to use global settings
        const globalPlanProfile = sm.getGlobalSettingsKey("planModeProfile")
        const globalActProfile = sm.getGlobalSettingsKey("actModeProfile")

        globalPlanProfile?.should.equal("global-plan-profile")
        globalActProfile?.should.equal("global-act-profile")
    })

    it("should use task-level profile when explicitly set, overriding global", () => {
        // Set global profiles
        sm.setGlobalState("planModeProfile" as any, "global-plan-profile")
        sm.setGlobalState("actModeProfile" as any, "global-act-profile")

        // Create task and set task-level profiles
        const taskSm = new TaskStateManager("task-with-override", sm)
        taskSm.setPlanModeProfile("task-specific-plan")
        taskSm.setActModeProfile("task-specific-act")

        // Task-level should take precedence
        taskSm.planModeProfile?.should.equal("task-specific-plan")
        taskSm.actModeProfile?.should.equal("task-specific-act")

        // Global settings remain unchanged
        const globalPlanProfile = sm.getGlobalSettingsKey("planModeProfile")
        const globalActProfile = sm.getGlobalSettingsKey("actModeProfile")
        globalPlanProfile?.should.equal("global-plan-profile")
        globalActProfile?.should.equal("global-act-profile")
    })

    it("should simulate Controller.getStateToPostToWebview() fallback logic", () => {
        // Set global profiles
        sm.setGlobalState("planModeProfile" as any, "global-claude")
        sm.setGlobalState("actModeProfile" as any, "global-gpt4")

        // Task 1: No task-level override (new task scenario)
        const taskSm1 = new TaskStateManager("new-task-1", sm)
        const task1PlanProfile = taskSm1.planModeProfile
        const task1ActProfile = taskSm1.actModeProfile

        // Simulate getStateToPostToWebview logic
        let apiConfig1 = {
            planModeProfile: sm.getGlobalSettingsKey("planModeProfile"),
            actModeProfile: sm.getGlobalSettingsKey("actModeProfile"),
        }
        if (task1PlanProfile !== undefined || task1ActProfile !== undefined) {
            apiConfig1 = {
                ...apiConfig1,
                ...(task1PlanProfile !== undefined && { planModeProfile: task1PlanProfile }),
                ...(task1ActProfile !== undefined && { actModeProfile: task1ActProfile }),
            }
        }
        // Should use global settings
        apiConfig1.planModeProfile?.should.equal("global-claude")
        apiConfig1.actModeProfile?.should.equal("global-gpt4")

        // Task 2: With task-level override (user changed profile)
        const taskSm2 = new TaskStateManager("task-with-profile-2", sm)
        taskSm2.setPlanModeProfile("task2-anthropic")
        taskSm2.setActModeProfile("task2-openai")

        const task2PlanProfile = taskSm2.planModeProfile
        const task2ActProfile = taskSm2.actModeProfile

        let apiConfig2 = {
            planModeProfile: sm.getGlobalSettingsKey("planModeProfile"),
            actModeProfile: sm.getGlobalSettingsKey("actModeProfile"),
        }
        if (task2PlanProfile !== undefined || task2ActProfile !== undefined) {
            apiConfig2 = {
                ...apiConfig2,
                ...(task2PlanProfile !== undefined && { planModeProfile: task2PlanProfile }),
                ...(task2ActProfile !== undefined && { actModeProfile: task2ActProfile }),
            }
        }
        // Should use task-specific settings
        apiConfig2.planModeProfile?.should.equal("task2-anthropic")
        apiConfig2.actModeProfile?.should.equal("task2-openai")
    })
})
