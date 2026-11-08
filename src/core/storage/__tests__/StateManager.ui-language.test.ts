import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getDefaultValue, SETTINGS_TRANSFORMS } from "@shared/storage/state-keys"
import { createStorageContext, type StorageContext } from "@shared/storage/storage-context"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeTaskSettingsToStorage } from "../disk"
import { StateManager } from "../StateManager"
import { SettingsRepository } from "../settings/SettingsRepository"

const diskFault = vi.hoisted(() => ({ destination: undefined as string | undefined, attempts: 0 }))

// Inject failure at the physical replacement boundary. Repository locking,
// validation, temporary-file I/O, cache adoption and reopen all remain real.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>()
    const rename: typeof actual.rename = async (source, destination) => {
        if (destination === diskFault.destination) {
            diskFault.attempts++
            throw Object.assign(new Error("Settings replacement failed"), { code: "ENOSPC" })
        }
        return actual.rename(source, destination)
    }
    return { ...actual, rename, default: { ...actual, rename } }
})

let root: string
let storage: StorageContext
const repositories: SettingsRepository[] = []

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ui-language-state-"))
    vi.stubEnv("DLINE_DIR", root)
    vi.stubEnv("DLINE_HOME_DIR", path.join(root, "home"))
    vi.stubEnv("DLINE_DOCS_DIR", path.join(root, "documents"))
    storage = createStorageContext({ clineDir: root, workspacePath: path.join(root, "workspace") })
    // Avoid reading the real machine identity even though the normal host registry
    // is mocked by backend setup.
    await storage.globalState.update("cline.generatedMachineId", "isolated-ui-language-installation")
    diskFault.destination = undefined
    diskFault.attempts = 0
})

afterEach(async () => {
    diskFault.destination = undefined
    await Promise.all(repositories.splice(0).map((repository) => repository.dispose()))
    await StateManager.resetForTest()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
})

async function openState(initial: Record<string, unknown> = {}): Promise<StateManager> {
    await fs.writeFile(storage.settingsFilePath, JSON.stringify({ __settingsMigrationVersion: 1, ...initial }))
    return StateManager.initialize(storage)
}

async function openRepository(filePath = storage.settingsFilePath): Promise<SettingsRepository> {
    const repository = new SettingsRepository({ filePath, watch: false })
    repositories.push(repository)
    await repository.initialize()
    return repository
}

async function readDocument(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(storage.settingsFilePath, "utf8"))
}

describe("StateManager committed UI language", () => {
    it("declares auto and normalizes legacy inputs through the state-key transform", () => {
        expect(getDefaultValue("uiLanguage")).toBe("auto")
        expect(SETTINGS_TRANSFORMS.uiLanguage?.("zh-CN")).toBe("zh-CN")
        expect(SETTINGS_TRANSFORMS.uiLanguage?.("unsupported")).toBe("auto")
    })

    it.each([
        undefined,
        null,
        42,
        "unsupported",
        "zh-cn",
        { language: "zh-CN" },
    ])("reads invalid or absent persisted preference %j as auto without repairing storage", async (uiLanguage) => {
        const state = await openState({ uiLanguage })
        const before = await fs.readFile(storage.settingsFilePath, "utf8")

        expect(state.getUiLanguagePreference()).toBe("auto")
        expect(await fs.readFile(storage.settingsFilePath, "utf8")).toBe(before)
        // Invalid historical language must not prevent an unrelated valid save.
        await state.mutateGlobalSettingsKey("showFeatureTips", () => false)
        expect(state.getUiLanguagePreference()).toBe("auto")
        expect((await readDocument()).showFeatureTips).toBe(false)
    })

    it.each(["auto", "en", "zh-CN"] as const)("persists and reopens the preference %s itself", async (uiLanguage) => {
        const state = await openState({ preferredLanguage: "model-language-fixture" })

        await state.mutateGlobalSettingsKey("uiLanguage", () => uiLanguage)
        await state.flushPendingState()
        expect(state.getUiLanguagePreference()).toBe(uiLanguage)
        expect(await readDocument()).toMatchObject({ uiLanguage, preferredLanguage: "model-language-fixture" })
        expect(storage.globalState.get("uiLanguage")).toBeUndefined()

        await StateManager.resetForTest()
        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        expect(reopened.getUiLanguagePreference()).toBe(uiLanguage)
        expect(reopened.getGlobalSettingsKey("preferredLanguage")).toBe("model-language-fixture")
    })

    it("ignores historical task, workspace, session, remote and optimistic overlays without changing other setting resolution", async () => {
        const state = await openState({ uiLanguage: "en", preferredLanguage: "English" })
        const workspace = await openRepository(storage.workspaceSettingsFilePath)
        await workspace.mutate({ uiLanguage: "zh-CN" })
        await writeTaskSettingsToStorage("historical-task", { uiLanguage: "zh-CN", preferredLanguage: "task-model-language" })
        await state.loadTaskSettings("historical-task")
        expect(state.getUiLanguagePreference()).toBe("en")
        expect(state.getGlobalSettingsKey("preferredLanguage")).toBe("task-model-language")

        state.setSessionOverride("uiLanguage", "zh-CN")
        state.setSessionOverride("preferredLanguage", "session-model-language")
        expect(state.getUiLanguagePreference()).toBe("en")
        expect(state.getGlobalSettingsKey("preferredLanguage")).toBe("session-model-language")

        state.setRemoteConfigField("uiLanguage", "zh-CN")
        state.setRemoteConfigField("preferredLanguage", "remote-model-language")
        expect(state.getUiLanguagePreference()).toBe("en")
        expect(state.getGlobalSettingsKey("preferredLanguage")).toBe("remote-model-language")

        state.setGlobalState("uiLanguage", "zh-CN")
        expect(state.getUiLanguagePreference()).toBe("en")
        expect((await readDocument()).uiLanguage).toBe("en")
    })

    it("adopts external commits and publishes the committed language to all registered consumers", async () => {
        const state = await openState({ uiLanguage: "auto" })
        const left = vi.fn()
        const right = vi.fn()
        const disposeLeft = state.registerCallbacks({
            onSyncExternalChange: (event) => {
                if (event.source === "settings") left(state.getUiLanguagePreference())
            },
        })
        state.registerCallbacks({
            onSyncExternalChange: (event) => {
                if (event.source === "settings") right(state.getUiLanguagePreference())
            },
        })
        const writer = await openRepository()

        await writer.mutate({ uiLanguage: "zh-CN" })
        await vi.waitFor(() => expect(state.getUiLanguagePreference()).toBe("zh-CN"), { timeout: 5_000 })
        expect(left).toHaveBeenLastCalledWith("zh-CN")
        expect(right).toHaveBeenLastCalledWith("zh-CN")

        disposeLeft()
        left.mockClear()
        await state.mutateGlobalSettingsKey("uiLanguage", () => "en")
        expect(left).not.toHaveBeenCalled()
        expect(right).toHaveBeenLastCalledWith("en")
    })

    it("never stages a failed repository write and keeps its committed read available during repository failure", async () => {
        const state = await openState({ uiLanguage: "en" })
        const before = await readDocument()
        const publication = vi.fn()
        state.registerCallbacks({
            onSyncExternalChange: (event) => {
                if (event.source === "settings") publication(state.getUiLanguagePreference())
            },
        })
        diskFault.destination = storage.settingsFilePath

        await expect(state.mutateGlobalSettingsKey("uiLanguage", () => "zh-CN")).rejects.toMatchObject({ code: "ENOSPC" })

        expect(diskFault.attempts).toBe(1)
        expect(await readDocument()).toEqual(before)
        expect(state.getUiLanguagePreference()).toBe("en")
        expect(() => state.readAwaySettingsSnapshot()).toThrow("unavailable")
        expect(publication).not.toHaveBeenCalled()

        diskFault.destination = undefined
        await state.mutateGlobalSettingsKey("showFeatureTips", () => false)
        expect(publication).toHaveBeenLastCalledWith("en")
        expect((await readDocument()).uiLanguage).toBe("en")
        await StateManager.resetForTest()
        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        expect(reopened.getUiLanguagePreference()).toBe("en")
    })
})
