import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "should"
import { createStorageContext } from "@shared/storage/storage-context"
import * as chai from "chai"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { StateManager } from "@/core/storage/StateManager"
import { TaskStateManager } from "../TaskStateManager"

describe("TaskStateManager - Multi-window Profile Isolation", () => {
    let tempDir: string
    let sm: StateManager

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-task-state-manager-"))
        vi.stubEnv("DLINE_DOCS_DIR", tempDir)
        expect(process.env.DLINE_DOCS_DIR).toBe(tempDir)
        const storageCtx = createStorageContext({ clineDir: tempDir })
        sm = await StateManager.initialize(storageCtx)
    })

    afterEach(async () => {
        await StateManager.resetForTest()
        vi.unstubAllEnvs()
        await fs.rm(tempDir, { recursive: true, force: true })
        await expect(fs.access(tempDir)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("should isolate profile settings between two tasks without activeTaskId interference", async () => {
        // Simulate two tasks (representing two windows)
        await sm.loadTaskSettings("task-window-1")
        await sm.loadTaskSettings("task-window-2")

        // Create TaskStateManager instances for each task
        const taskSm1 = new TaskStateManager("task-window-1", sm)
        const taskSm2 = new TaskStateManager("task-window-2", sm)

        // Window 1 sets its profile to "anthropic"
        taskSm1.setPlanModeProfile("anthropic")
        taskSm1.setActModeProfile("anthropic-act")

        // Window 2 sets its profile to "openai"
        taskSm2.setPlanModeProfile("openai")
        taskSm2.setActModeProfile("openai-act")

        // Verify isolation: each task reads its own profile
        taskSm1.planModeProfile?.should.equal("anthropic")
        taskSm1.actModeProfile?.should.equal("anthropic-act")
        taskSm2.planModeProfile?.should.equal("openai")
        taskSm2.actModeProfile?.should.equal("openai-act")

        // Simulate activeTaskId switching (what Controller does when posting state)
        sm.setActiveTaskId("task-window-1")
        sm.setActiveTaskId("task-window-2")
        sm.setActiveTaskId("task-window-1")

        // After activeTaskId switching, TaskStateManager should still read correct values
        taskSm1.planModeProfile?.should.equal("anthropic")
        taskSm1.actModeProfile?.should.equal("anthropic-act")
        taskSm2.planModeProfile?.should.equal("openai")
        taskSm2.actModeProfile?.should.equal("openai-act")
    })

    it("isolates capability snapshots between task windows", () => {
        const taskSm1 = new TaskStateManager("task-window-1", sm)
        const taskSm2 = new TaskStateManager("task-window-2", sm)
        taskSm1.setTaskCapabilityToggles('{"mcpServers":{"docs":true}}')
        taskSm2.setTaskCapabilityToggles('{"mcpServers":{"docs":false}}')

        sm.setActiveTaskId("task-window-2")
        expect(taskSm1.taskCapabilityToggles).toBe('{"mcpServers":{"docs":true}}')
        sm.setActiveTaskId("task-window-1")
        expect(taskSm2.taskCapabilityToggles).toBe('{"mcpServers":{"docs":false}}')
    })

    it("builds API configuration for an explicit task without using the active task cursor", async () => {
        await sm.loadTaskSettings("task-window-1")
        await sm.loadTaskSettings("task-window-2")
        sm.setGlobalState("planActSeparateModelsSetting", true)
        sm.setTaskSettingsBatch("task-window-1", {
            mode: "plan",
            planModeProfile: "deepseek-plan",
            actModeProfile: "deepseek-act",
        })
        sm.setTaskSettingsBatch("task-window-2", {
            mode: "act",
            planModeProfile: "openai-plan",
            actModeProfile: "openai-act",
        })
        sm.setActiveTaskId("task-window-2")

        const taskOneConfig = sm.getApiConfigurationForTask("task-window-1")

        expect(taskOneConfig.planModeProfile).toBe("deepseek-plan")
        expect(taskOneConfig.actModeProfile).toBe("deepseek-act")
        expect(sm.getSettingsKeyForTask("mode", "task-window-1")).toBe("plan")
        expect(sm.getSettingsKeyForTask("mode", "task-window-2")).toBe("act")
    })

    it("uses global profiles for a new task while another task is the active cursor", () => {
        sm.setGlobalState("planModeProfile", "global-chat")
        sm.setGlobalState("actModeProfile", "global-chat")
        sm.setTaskSettingsBatch("task-window-1", {
            planModeProfile: "panel-responses",
            actModeProfile: "panel-responses",
        })
        sm.setActiveTaskId("task-window-1")

        const newTaskConfig = sm.getApiConfigurationForTask("task-window-2")

        expect(newTaskConfig.planModeProfile).toBe("global-chat")
        expect(newTaskConfig.actModeProfile).toBe("global-chat")
    })

    it("reuses an existing task identity for a missing mode when Profile split is disabled", async () => {
        await sm.loadTaskSettings("task-unified-partial")
        sm.setGlobalState("planActSeparateModelsSetting", false)
        sm.setGlobalState("planModeProfileId", "global-id")
        sm.setGlobalState("planModeProfile", "global-deepseek")
        sm.setGlobalState("actModeProfileId", "global-id")
        sm.setGlobalState("actModeProfile", "global-deepseek")
        sm.setTaskSettingsBatch("task-unified-partial", {
            mode: "act",
            planModeProfileId: "task-id",
            planModeProfile: "task-responses",
        })

        const configuration = sm.getApiConfigurationForTask("task-unified-partial")

        expect(configuration).toMatchObject({
            planModeProfileId: "task-id",
            planModeProfile: "task-responses",
            actModeProfileId: "task-id",
            actModeProfile: "task-responses",
        })
    })

    it("clears only the requested task cache when another window is active", async () => {
        const taskSm1 = new TaskStateManager("task-window-1", sm)
        const taskSm2 = new TaskStateManager("task-window-2", sm)
        taskSm1.setActModeProfile("deepseek-act")
        taskSm2.setActModeProfile("openai-act")
        sm.setActiveTaskId("task-window-2")

        await sm.clearTaskSettings("task-window-1")

        expect(taskSm2.actModeProfile).toBe("openai-act")
        expect(sm.getApiConfigurationForTask("task-window-2").actModeProfile).toBe("openai-act")
    })

    it("should return undefined for profiles when not set at task level", () => {
        const taskSm = new TaskStateManager("task-new", sm)

        // Should return undefined, allowing fallback to global settings
        chai.expect(taskSm.planModeProfile).to.be.undefined
        chai.expect(taskSm.actModeProfile).to.be.undefined
    })

    it("should keep persisted history profiles when global defaults change", async () => {
        await sm.loadTaskSettings("task-history")
        const taskSm = new TaskStateManager("task-history", sm)
        taskSm.setPlanModeProfile("history-plan")
        taskSm.setActModeProfile("history-act")
        sm.setGlobalState("planModeProfile", "global-plan")
        sm.setGlobalState("actModeProfile", "global-act")

        const effectiveConfig = {
            ...sm.getApiConfiguration(),
            ...(taskSm.planModeProfile !== undefined && { planModeProfile: taskSm.planModeProfile }),
            ...(taskSm.actModeProfile !== undefined && { actModeProfile: taskSm.actModeProfile }),
        }

        effectiveConfig.planModeProfile?.should.equal("history-plan")
        effectiveConfig.actModeProfile?.should.equal("history-act")
    })

    it("should persist profile changes via markTaskSettingDirty", async () => {
        await sm.loadTaskSettings("task-persist")
        const taskSm = new TaskStateManager("task-persist", sm)

        taskSm.setPlanModeProfile("claude-3.5")
        taskSm.setActModeProfile("gpt-4")

        // Flush to ensure persistence
        await sm.flushPendingState()

        // Create a new TaskStateManager instance to verify persistence
        const taskSm2 = new TaskStateManager("task-persist", sm)
        taskSm2.planModeProfile?.should.equal("claude-3.5")
        taskSm2.actModeProfile?.should.equal("gpt-4")
    })

    it("isolates and durably restores Task-local reasoning and service tier overrides", async () => {
        await sm.loadTaskSettings("task-override-1")
        await sm.loadTaskSettings("task-override-2")
        const taskSm1 = new TaskStateManager("task-override-1", sm)
        const taskSm2 = new TaskStateManager("task-override-2", sm)

        taskSm1.setReasoningOverride("act", { kind: "effort", effort: "high" })
        taskSm1.setServiceTierOverride("act", { kind: "tier", tier: "priority" })
        taskSm2.setReasoningOverride("act", { kind: "budget", budgetTokens: 4_096 })
        taskSm2.setServiceTierOverride("act", { kind: "tier", tier: "flex" })

        sm.setActiveTaskId("task-override-2")
        expect(sm.getApiConfigurationForTask("task-override-1").actModeReasoningOverride).toEqual({
            kind: "effort",
            effort: "high",
        })
        expect(sm.getApiConfigurationForTask("task-override-1").actModeServiceTierOverride).toEqual({
            kind: "tier",
            tier: "priority",
        })
        sm.setActiveTaskId("task-override-1")
        expect(sm.getApiConfigurationForTask("task-override-2").actModeReasoningOverride).toEqual({
            kind: "budget",
            budgetTokens: 4_096,
        })
        expect(sm.getApiConfigurationForTask("task-override-2").actModeServiceTierOverride).toEqual({
            kind: "tier",
            tier: "flex",
        })

        await sm.flushPendingState()
        await StateManager.resetForTest()
        sm = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))
        await sm.loadTaskSettings("task-override-1")
        await sm.loadTaskSettings("task-override-2")

        expect(sm.getApiConfigurationForTask("task-override-1").actModeReasoningOverride).toEqual({
            kind: "effort",
            effort: "high",
        })
        expect(sm.getApiConfigurationForTask("task-override-1").actModeServiceTierOverride).toEqual({
            kind: "tier",
            tier: "priority",
        })
        expect(sm.getApiConfigurationForTask("task-override-2").actModeReasoningOverride).toEqual({
            kind: "budget",
            budgetTokens: 4_096,
        })
        expect(sm.getApiConfigurationForTask("task-override-2").actModeServiceTierOverride).toEqual({
            kind: "tier",
            tier: "flex",
        })
    })

    it("clears an inherited Task override without changing another Task", () => {
        const taskSm1 = new TaskStateManager("task-inherit-1", sm)
        const taskSm2 = new TaskStateManager("task-inherit-2", sm)
        taskSm1.setReasoningOverride("plan", { kind: "effort", effort: "high" })
        taskSm1.setServiceTierOverride("plan", { kind: "tier", tier: "scale" })
        taskSm2.setReasoningOverride("plan", { kind: "budget", budgetTokens: 2_048 })
        taskSm2.setServiceTierOverride("plan", { kind: "tier", tier: "flex" })

        taskSm1.setReasoningOverride("plan", { kind: "inherit" })
        taskSm1.setServiceTierOverride("plan", { kind: "inherit" })

        expect(taskSm1.getReasoningOverride("plan")).toBeUndefined()
        expect(taskSm1.getServiceTierOverride("plan")).toBeUndefined()
        expect(taskSm2.getReasoningOverride("plan")).toEqual({ kind: "budget", budgetTokens: 2_048 })
        expect(taskSm2.getServiceTierOverride("plan")).toEqual({ kind: "tier", tier: "flex" })
    })

    it("clears only switched-mode runtime overrides, restores rollback state, and persists the cleared state", async () => {
        const taskId = "task-profile-switch"
        await sm.loadTaskSettings(taskId)
        sm.setTaskSettingsBatch(taskId, {
            planModeProfileId: "plan-source-id",
            planModeProfile: "plan-source",
            planModeReasoningOverrideKind: "budget",
            planModeThinkingBudgetTokens: 2_048,
            planModeServiceTierOverrideKind: "tier",
            planModeServiceTierOverrideTier: "scale",
            actModeProfileId: "act-source-id",
            actModeProfile: "act-source",
            actModeReasoningOverrideKind: "effort",
            actModeReasoningOverrideEffort: "low",
            actModeThinkingBudgetTokens: 4_096,
            actModeServiceTierOverrideKind: "tier",
            actModeServiceTierOverrideTier: "priority",
        })
        const taskSm = new TaskStateManager(taskId, sm)

        const snapshot = taskSm.setProfileIdentityBindings(
            { act: { profileId: "act-target-id", profileName: "act-target" } },
            { clearRuntimeOverrides: true },
        )
        const cache = sm.getTaskCacheRef(taskId)

        expect(snapshot.plan).toBeUndefined()
        expect(snapshot.act).toMatchObject({
            actModeProfileId: "act-source-id",
            actModeProfile: "act-source",
            actModeReasoningOverrideKind: "effort",
            actModeReasoningOverrideEffort: "low",
            actModeThinkingBudgetTokens: 4_096,
            actModeServiceTierOverrideKind: "tier",
            actModeServiceTierOverrideTier: "priority",
        })
        expect(taskSm.actModeProfileId).toBe("act-target-id")
        expect(taskSm.actModeProfile).toBe("act-target")
        expect(taskSm.getReasoningOverride("act")).toBeUndefined()
        expect(taskSm.getServiceTierOverride("act")).toBeUndefined()
        expect(cache.actModeReasoningOverrideKind).toBeUndefined()
        expect(taskSm.planModeProfileId).toBe("plan-source-id")
        expect(taskSm.getReasoningOverride("plan")).toEqual({ kind: "budget", budgetTokens: 2_048 })
        expect(taskSm.getServiceTierOverride("plan")).toEqual({ kind: "tier", tier: "scale" })
        expect(cache.planModeThinkingBudgetTokens).toBe(2_048)

        taskSm.restoreProfileState(snapshot)
        expect(taskSm.actModeProfileId).toBe("act-source-id")
        expect(taskSm.actModeProfile).toBe("act-source")
        expect(taskSm.getReasoningOverride("act")).toEqual({ kind: "effort", effort: "low" })
        expect(taskSm.getServiceTierOverride("act")).toEqual({ kind: "tier", tier: "priority" })
        expect(cache.actModeThinkingBudgetTokens).toBe(4_096)
        expect(cache.actModeReasoningOverrideEffort).toBe("low")

        taskSm.setProfileIdentityBindings(
            { act: { profileId: "act-target-id", profileName: "act-target" } },
            { clearRuntimeOverrides: true },
        )
        await sm.flushPendingState()
        await StateManager.resetForTest()
        sm = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))
        await sm.loadTaskSettings(taskId)
        const reopenedTaskSm = new TaskStateManager(taskId, sm)
        const reopenedCache = sm.getTaskCacheRef(taskId)

        expect(reopenedTaskSm.actModeProfileId).toBe("act-target-id")
        expect(reopenedTaskSm.actModeProfile).toBe("act-target")
        expect(reopenedTaskSm.getReasoningOverride("act")).toBeUndefined()
        expect(reopenedTaskSm.getServiceTierOverride("act")).toBeUndefined()
        expect(reopenedCache.actModeReasoningOverrideKind).toBeUndefined()
        expect(reopenedTaskSm.planModeProfileId).toBe("plan-source-id")
        expect(reopenedTaskSm.getReasoningOverride("plan")).toEqual({ kind: "budget", budgetTokens: 2_048 })
        expect(reopenedTaskSm.getServiceTierOverride("plan")).toEqual({ kind: "tier", tier: "scale" })
    })

    it("should handle concurrent profile updates from multiple windows", () => {
        // Simulate rapid concurrent updates (race condition scenario)
        const taskSm1 = new TaskStateManager("task-race-1", sm)
        const taskSm2 = new TaskStateManager("task-race-2", sm)
        const taskSm3 = new TaskStateManager("task-race-3", sm)

        // All three windows update at the same time
        taskSm1.setPlanModeProfile("profile-1")
        taskSm2.setPlanModeProfile("profile-2")
        taskSm3.setPlanModeProfile("profile-3")

        // Each should maintain its own value
        taskSm1.planModeProfile?.should.equal("profile-1")
        taskSm2.planModeProfile?.should.equal("profile-2")
        taskSm3.planModeProfile?.should.equal("profile-3")

        // Simulate activeTaskId thrashing
        for (let i = 0; i < 10; i++) {
            sm.setActiveTaskId("task-race-1")
            sm.setActiveTaskId("task-race-2")
            sm.setActiveTaskId("task-race-3")
        }

        // Values should remain stable
        taskSm1.planModeProfile?.should.equal("profile-1")
        taskSm2.planModeProfile?.should.equal("profile-2")
        taskSm3.planModeProfile?.should.equal("profile-3")
    })
})
