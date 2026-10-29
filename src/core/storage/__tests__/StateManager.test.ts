/**
 * Unit tests for StateManager per-task settings isolation (Map-based cache).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "should"
import { createStorageContext } from "@shared/storage/storage-context"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readTaskSettingsFromStorage, writeTaskSettingsToStorage } from "../disk"
import { REMOVED_SETTINGS_KEYS } from "../removed-settings-keys"
import { StateManager } from "../StateManager"
import { SettingsRepository } from "../settings/SettingsRepository"

function getTaskStateCache(sm: StateManager): Map<string, any> {
    return (sm as any).taskStateCache
}
function getActiveTaskId(sm: StateManager): string | undefined {
    return (sm as any).activeTaskId
}

describe("StateManager — Per-Task Settings Isolation", () => {
    let tempDir: string
    let sm: StateManager

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-state-manager-"))
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

    describe("taskStateCache Map basics", () => {
        it("should store per-task caches as a Map", () => {
            const cache = getTaskStateCache(sm)
            ;(cache instanceof Map).should.be.true()
        })
        it("should start with empty task caches after init", () => {
            getTaskStateCache(sm).size.should.equal(0)
        })
        it("should have no activeTaskId after init", () => {
            ;(getActiveTaskId(sm) === undefined).should.be.true()
        })
    })

    describe("setActiveTask and loadTaskSettings", () => {
        it("should set activeTaskId when loading task settings", async () => {
            await sm.loadTaskSettings("task-1")
            getActiveTaskId(sm)?.should.equal("task-1")
        })
        it("should create cache entry via setActiveTask", () => {
            sm.setActiveTask("task-1")
            const cache = getTaskStateCache(sm)
            cache.has("task-1").should.be.true()
            getActiveTaskId(sm)?.should.equal("task-1")
        })
        it("should switch activeTaskId when loading a different task", async () => {
            await sm.loadTaskSettings("task-1")
            await sm.loadTaskSettings("task-2")
            getActiveTaskId(sm)?.should.equal("task-2")
        })
    })

    describe("per-task settings isolation", () => {
        it("should isolate settings between two tasks", () => {
            sm.setActiveTask("task-A")
            sm.setTaskSettings("task-A", "mode", "plan" as any)
            sm.setTaskSettings("task-A", "planModeProfile", "anthropic" as any)
            sm.setActiveTask("task-B")
            sm.setTaskSettings("task-B", "mode", "act" as any)
            sm.setTaskSettings("task-B", "planModeProfile", "openrouter" as any)
            sm.setActiveTask("task-A")
            sm.getGlobalSettingsKey("mode")?.should.equal("plan")
            sm.getGlobalSettingsKey("planModeProfile")?.should.equal("anthropic")
            sm.setActiveTask("task-B")
            sm.getGlobalSettingsKey("mode")?.should.equal("act")
            sm.getGlobalSettingsKey("planModeProfile")?.should.equal("openrouter")
        })
        it("should fallback to global settings when task cache doesn't have key", () => {
            sm.setGlobalState("mode" as any, "act" as any)
            sm.setActiveTask("task-A")
            sm.setTaskSettings("task-A", "planModeProfile", "anthropic" as any)
            sm.getGlobalSettingsKey("planModeProfile")?.should.equal("anthropic")
            sm.getGlobalSettingsKey("mode")?.should.equal("act")
        })
        it("should allow batch settings update per task", () => {
            sm.setActiveTask("task-A")
            sm.setTaskSettingsBatch("task-A", {
                mode: "plan" as any,
                planModeProfile: "anthropic" as any,
                yoloModeToggled: true as any,
            })
            sm.getGlobalSettingsKey("mode")?.should.equal("plan")
            sm.getGlobalSettingsKey("planModeProfile")?.should.equal("anthropic")
            sm.getGlobalSettingsKey("yoloModeToggled")?.should.equal(true)
        })
        it("should not leak task-A settings into task-B", () => {
            sm.setActiveTask("task-A")
            sm.setTaskSettings("task-A", "mode", "plan" as any)
            sm.setActiveTask("task-B")
            const taskBCache = getTaskStateCache(sm).get("task-B")
            ;(!taskBCache || taskBCache.mode === undefined).should.be.true()
        })
        it("should support 3 concurrent tasks with independent settings", () => {
            sm.setActiveTask("task-1")
            sm.setTaskSettings("task-1", "mode", "plan" as any)
            sm.setActiveTask("task-2")
            sm.setTaskSettings("task-2", "mode", "act" as any)
            sm.setActiveTask("task-3")
            sm.setTaskSettings("task-3", "mode", "plan" as any)
            sm.setActiveTask("task-1")
            sm.getGlobalSettingsKey("mode")?.should.equal("plan")
            sm.setActiveTask("task-2")
            sm.getGlobalSettingsKey("mode").should.equal("act")
            sm.setActiveTask("task-3")
            sm.getGlobalSettingsKey("mode")?.should.equal("plan")
        })
    })

    describe("clearTaskSettings", () => {
        it("should clear only the active task's cache", async () => {
            sm.setActiveTask("task-A")
            sm.setTaskSettings("task-A", "mode", "plan" as any)
            sm.setActiveTask("task-B")
            sm.setTaskSettings("task-B", "mode", "act" as any)
            await sm.clearTaskSettings()
            getTaskStateCache(sm).has("task-B").should.be.false()
            getTaskStateCache(sm).has("task-A").should.be.true()
            ;(getActiveTaskId(sm) === undefined).should.be.true()
        })
        it("should not affect other tasks when clearing", async () => {
            sm.setActiveTask("task-A")
            sm.setTaskSettings("task-A", "mode", "plan" as any)
            sm.setActiveTask("task-B")
            await sm.clearTaskSettings()
            sm.setActiveTask("task-A")
            sm.getGlobalSettingsKey("mode")?.should.equal("plan")
        })
    })

    describe("getApiConfiguration with per-task overrides", () => {
        it("should project the canonical workspace identity into every API configuration", () => {
            const current = sm.getApiConfiguration()
            const explicitTask = sm.getApiConfigurationForTask("task-A")
            if (!current.workspaceId || !explicitTask.workspaceId) throw new Error("Workspace identity was not projected")

            current.workspaceId.should.match(/^dline_workspace_[0-9a-f]{32}$/)
            explicitTask.workspaceId.should.equal(current.workspaceId)
        })

        it("should return per-task provider in ApiConfiguration", () => {
            sm.setGlobalState("planModeProfile" as any, "openrouter" as any)
            sm.setActiveTask("task-A")
            sm.setTaskSettings("task-A", "planModeProfile", "anthropic" as any)
            sm.getApiConfiguration().planModeProfile?.should.equal("anthropic")
        })
        it("should return global provider when no task override", () => {
            sm.setGlobalState("planModeProfile" as any, "openrouter" as any)
            sm.setActiveTask("task-empty")
            sm.getApiConfiguration().planModeProfile?.should.equal("openrouter")
        })
        it("should fallback to global provider after clearing a task override", () => {
            sm.setGlobalState("planModeProfile", "openrouter")
            sm.setActiveTask("task-A")
            sm.setTaskSettings("task-A", "planModeProfile", "anthropic")
            sm.getApiConfiguration().planModeProfile?.should.equal("anthropic")
            sm.clearTaskSetting("task-A", "planModeProfile")
            sm.getApiConfiguration().planModeProfile?.should.equal("openrouter")
        })

        it("returns the global image profile independently from plan and act profiles", () => {
            // Separate plan/act models keep both bindings distinct; without it the
            // unified binding collapses plan and act onto the same profile.
            sm.setGlobalState("planActSeparateModelsSetting", true)
            sm.setGlobalState("planModeProfile", "anthropic-plan")
            sm.setGlobalState("actModeProfile", "openai-act")
            sm.setGlobalState("imageProfile", "openai-images")

            expect(sm.getApiConfiguration()).toMatchObject({
                planModeProfile: "anthropic-plan",
                actModeProfile: "openai-act",
                imageProfile: "openai-images",
            })
        })

        it("keeps the image profile while a unified binding collapses plan and act profiles", () => {
            sm.setGlobalState("planActSeparateModelsSetting", false)
            sm.setGlobalState("mode", "act")
            sm.setGlobalState("planModeProfile", "anthropic-plan")
            sm.setGlobalState("actModeProfile", "openai-act")
            sm.setGlobalState("imageProfile", "openai-images")

            expect(sm.getApiConfiguration()).toMatchObject({
                planModeProfile: "openai-act",
                actModeProfile: "openai-act",
                imageProfile: "openai-images",
            })
        })
    })

    describe("settings repository synchronization", () => {
        it("broadcasts a committed Settings revision to every registered controller callback", async () => {
            const first = vi.fn().mockResolvedValue(undefined)
            const second = vi.fn().mockResolvedValue(undefined)
            const disposeFirst = sm.registerCallbacks({ onSyncExternalChange: first })
            const disposeSecond = sm.registerCallbacks({ onSyncExternalChange: second })

            await (sm as any).settingsRepository.mutate({ chatInputSendShortcut: "ctrlEnter" })

            expect(first).toHaveBeenCalledOnce()
            expect(first).toHaveBeenCalledWith({
                source: "settings",
                commit: expect.objectContaining({ changedKeys: ["chatInputSendShortcut"] }),
            })
            expect(second).toHaveBeenCalledOnce()
            disposeFirst()
            disposeSecond()
        })

        it("uses the declared default after a committed Settings key is deleted", async () => {
            await (sm as any).settingsRepository.mutate({ showFeatureTips: false })
            sm.getGlobalSettingsKey("showFeatureTips").should.equal(false)

            await (sm as any).settingsRepository.mutate({ showFeatureTips: undefined })

            sm.getGlobalSettingsKey("showFeatureTips").should.equal(true)
        })

        it("restores the declared default after a StateManager Settings deletion is committed", async () => {
            await (sm as any).settingsRepository.mutate({ showFeatureTips: false })
            sm.getGlobalSettingsKey("showFeatureTips").should.equal(false)

            sm.setGlobalState("showFeatureTips", undefined)
            await sm.flushPendingState()

            sm.getGlobalSettingsKey("showFeatureTips").should.equal(true)
        })

        it("persists atomic global capability map mutations across restart", async () => {
            await sm.mutateGlobalSettingsKey("globalSkillsToggles", (current) => ({
                ...current,
                "/global/skill/SKILL.md": false,
            }))

            await StateManager.resetForTest()
            const restarted = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))

            restarted.getGlobalSettingsKey("globalSkillsToggles").should.deepEqual({
                "/global/skill/SKILL.md": false,
            })
        })

        it("routes Settings keys in a batch through the canonical repository", async () => {
            sm.setGlobalStateBatch({
                chatInputSendShortcut: "ctrlEnter",
                terminalOutputLineLimit: 900,
            })
            await sm.flushPendingState()

            const settingsStorage = createStorageContext({ clineDir: tempDir }).settings
            settingsStorage.get("chatInputSendShortcut").should.equal("ctrlEnter")
            settingsStorage.get("terminalOutputLineLimit").should.equal(900)
        })

        it("keeps pending Settings durable when the StateManager shuts down", async () => {
            sm.setGlobalState("chatInputSendShortcut", "ctrlEnter")
            await (StateManager as any).shutdown()

            const restarted = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))
            restarted.getGlobalSettingsKey("chatInputSendShortcut").should.equal("ctrlEnter")
        })

        it("does not clear a Settings mutation created while an earlier flush is in flight", async () => {
            const repository = (sm as any).settingsRepository as {
                mutate: (patch: Partial<Record<string, unknown>>, sourceId?: string) => Promise<unknown>
            }
            const originalMutate = repository.mutate.bind(repository)
            let releaseFirstCommit!: () => void
            let markFirstCommitStarted!: () => void
            const firstCommitStarted = new Promise<void>((resolve) => {
                markFirstCommitStarted = resolve
            })
            const firstCommitRelease = new Promise<void>((resolve) => {
                releaseFirstCommit = resolve
            })
            let isFirstCommit = true
            vi.spyOn(repository, "mutate").mockImplementation(async (patch, sourceId) => {
                if (isFirstCommit) {
                    isFirstCommit = false
                    markFirstCommitStarted()
                    await firstCommitRelease
                }
                return originalMutate(patch, sourceId)
            })

            sm.setGlobalState("chatInputSendShortcut", "ctrlEnter")
            const firstFlush = sm.flushPendingState()
            await firstCommitStarted
            sm.setGlobalState("terminalOutputLineLimit", 900)
            releaseFirstCommit()
            await firstFlush
            await sm.flushPendingState()

            const settingsStorage = createStorageContext({ clineDir: tempDir }).settings
            settingsStorage.get("chatInputSendShortcut").should.equal("ctrlEnter")
            settingsStorage.get("terminalOutputLineLimit").should.equal(900)
        })

        it("should route a Settings key to settings.json only", async () => {
            sm.setGlobalState("mode" as any, "plan" as any)
            await sm.flushPendingState()

            sm.getGlobalSettingsKey("mode" as any)?.should.equal("plan")
            // Projecting the same value into global state would persist a duplicate
            // that later diverges from the canonical Settings document.
            expect((sm as any).globalStateCache["mode"]).toBeUndefined()
        })

        it("should read settings from settingsCache first", async () => {
            // Pre-populate settings via setGlobalState (dual-write)
            sm.setGlobalState("mode" as any, "plan" as any)
            await sm.flushPendingState()

            // Reset and re-init — should load from settings.json
            await StateManager.resetForTest()
            const sm2 = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))

            sm2.getGlobalSettingsKey("mode" as any)?.should.equal("plan")
            await StateManager.resetForTest()
        })

        it("should fallback to the legacy snapshot when settingsCache is empty", () => {
            // A pre-migration install still holds its value in the legacy global
            // state file, which is captured into the fallback cache at startup.
            delete (sm as any).settingsCache["yoloModeToggled"]
            ;(sm as any).settingsFallbackActive = true
            ;(sm as any).settingsFallbackCache["yoloModeToggled"] = true

            sm.getGlobalSettingsKey("yoloModeToggled" as any)?.should.equal(true)
        })

        it("should fall back to the declared default once the legacy snapshot is retired", () => {
            delete (sm as any).settingsCache["terminalOutputLineLimit"]
            ;(sm as any).settingsFallbackActive = false
            ;(sm as any).settingsFallbackCache = {}

            sm.getGlobalSettingsKey("terminalOutputLineLimit").should.equal(500)
        })
    })

    describe("secrets routing to split stores", () => {
        it("should route and persist account/wandb secrets", async () => {
            // Route writes to split stores
            sm.setSecret("clineApiKey", "test-key")
            sm.setSecret("clineAccountId", "acc-456")
            sm.setSecret("wandbApiKey", "wandb-key")
            await sm.flushPendingState()

            sm.getSecretKey("clineApiKey")!.should.equal("test-key")
            sm.getSecretKey("clineAccountId")!.should.equal("acc-456")
            sm.getSecretKey("wandbApiKey")!.should.equal("wandb-key")

            // Persist across re-init
            await StateManager.resetForTest()
            const sm2 = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))

            sm2.getSecretKey("clineApiKey")!.should.equal("test-key")
            sm2.getSecretKey("wandbApiKey")!.should.equal("wandb-key")
            await StateManager.resetForTest()
        })
    })

    describe("settings migration from globalState", () => {
        it("should migrate settings from globalState.json to settings.json on first start", async () => {
            // The beforeEach already created a clean instance with migration run.
            // Verify sentinel and migrated value exist in settings store.
            const storageCtx = createStorageContext({ clineDir: tempDir })
            const sentinel = storageCtx.settings.get("__settingsMigrationVersion")
            sentinel?.should.equal(2)
        })

        it("should fill missing global capability toggles from legacy global state during the v2 upgrade", async () => {
            await StateManager.resetForTest()
            const storageCtx = createStorageContext({ clineDir: tempDir })
            await storageCtx.settings.update("__settingsMigrationVersion", 1)
            await storageCtx.globalState.update("globalSkillsToggles", { "/global/skill/SKILL.md": false })

            const migrated = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))

            migrated.getGlobalSettingsKey("globalSkillsToggles").should.deepEqual({
                "/global/skill/SKILL.md": false,
            })
            const migratedStorage = createStorageContext({ clineDir: tempDir })
            migratedStorage.settings.get("__settingsMigrationVersion")?.should.equal(2)
            migratedStorage.settings.get("globalSkillsToggles")?.should.deepEqual({
                "/global/skill/SKILL.md": false,
            })
        })

        it("should preserve canonical global capability toggles during the v2 upgrade", async () => {
            await StateManager.resetForTest()
            const storageCtx = createStorageContext({ clineDir: tempDir })
            await storageCtx.settings.setBatch({
                __settingsMigrationVersion: 1,
                globalWorkflowToggles: { "/canonical/workflow.md": false },
            })
            await storageCtx.globalState.update("globalWorkflowToggles", { "/legacy/workflow.md": true })

            const migrated = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))

            migrated.getGlobalSettingsKey("globalWorkflowToggles").should.deepEqual({
                "/canonical/workflow.md": false,
            })
            const migratedStorage = createStorageContext({ clineDir: tempDir })
            migratedStorage.settings.get("__settingsMigrationVersion")?.should.equal(2)
            migratedStorage.settings.get("globalWorkflowToggles")?.should.deepEqual({
                "/canonical/workflow.md": false,
            })
        })

        it("should keep task history inside the injected storage boundary", () => {
            const storageCtx = createStorageContext({ clineDir: tempDir })
            storageCtx.taskHistoryPath.should.equal(path.join(tempDir, "tasks", "taskHistory.jsonl"))
        })
    })

    describe("removed settings keys", () => {
        const settingsFile = () => path.join(tempDir, "data", "settings", "settings.json")

        async function seedSettings(values: Record<string, unknown>): Promise<void> {
            await StateManager.resetForTest()
            await createStorageContext({ clineDir: tempDir }).settings.setBatch(values)
        }

        it("removes them from settings.json on startup and leaves a clean document untouched", async () => {
            await seedSettings({ planModeOcaModelId: "oca-model", actModeReasoningEffort: "high", preferredLanguage: "zh-CN" })

            const restarted = await StateManager.initialize(createStorageContext({ clineDir: tempDir }))

            const persisted = createStorageContext({ clineDir: tempDir }).settings
            expect(persisted.get("planModeOcaModelId")).toBeUndefined()
            expect(persisted.get("actModeReasoningEffort")).toBeUndefined()
            expect(persisted.get("preferredLanguage")).toBe("zh-CN")
            expect(restarted.getGlobalSettingsKey("preferredLanguage")).toBe("zh-CN")

            const cleaned = await fs.readFile(settingsFile(), "utf8")
            await StateManager.resetForTest()
            await StateManager.initialize(createStorageContext({ clineDir: tempDir }))
            expect(await fs.readFile(settingsFile(), "utf8")).toBe(cleaned)
        })

        it("does not block startup when the cleanup write fails, and retries on the next launch", async () => {
            await seedSettings({ planModeOpenRouterModelId: "openrouter/model" })
            const original = SettingsRepository.prototype.mutateResolved
            const spy = vi.spyOn(SettingsRepository.prototype, "mutateResolved").mockImplementation(function (
                this: SettingsRepository,
                resolvePatch,
                sourceId,
            ) {
                const patch = resolvePatch(this.readSnapshot().values)
                if (Object.keys(patch).some((key) => REMOVED_SETTINGS_KEYS.includes(key))) {
                    return Promise.reject(new Error("disk full"))
                }
                return original.call(this, resolvePatch, sourceId)
            })

            await StateManager.initialize(createStorageContext({ clineDir: tempDir }))
            expect(createStorageContext({ clineDir: tempDir }).settings.get("planModeOpenRouterModelId")).toBe("openrouter/model")

            spy.mockRestore()
            await StateManager.resetForTest()
            await StateManager.initialize(createStorageContext({ clineDir: tempDir }))
            expect(createStorageContext({ clineDir: tempDir }).settings.get("planModeOpenRouterModelId")).toBeUndefined()
        })

        it("strips them from a task settings document when the task loads", async () => {
            await writeTaskSettingsToStorage("task-legacy", {
                actModeReasoningEffort: "high",
                actModeReasoningOverrideKind: "inherit",
            } as Record<string, unknown>)

            await sm.loadTaskSettings("task-legacy")
            expect(getTaskStateCache(sm).get("task-legacy")).not.toHaveProperty("actModeReasoningEffort")
            await sm.flushPendingState()

            const persisted = (await readTaskSettingsFromStorage("task-legacy")) as Record<string, unknown>
            expect(persisted).not.toHaveProperty("actModeReasoningEffort")
            expect(persisted.actModeReasoningOverrideKind).toBe("inherit")
        })
    })
})
