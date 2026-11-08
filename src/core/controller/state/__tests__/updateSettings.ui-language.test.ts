import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Settings, UpdateSettingsRequest } from "@shared/proto/dline/state"
import { Logger } from "@shared/services/Logger"
import { createStorageContext, type StorageContext } from "@shared/storage/storage-context"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClineEnv } from "@/config"
import { StateManager } from "@/core/storage/StateManager"
import type { Controller } from "../.."
import { accountLogoutClicked } from "../../account/accountLogoutClicked"
import { getAwaySettings } from "../awaySettings"
import { planExternalStateChange } from "../externalStateChangePlan"
import { updateSettings } from "../updateSettings"

vi.mock("@/core/controller/account/accountLogoutClicked", () => ({ accountLogoutClicked: vi.fn() }))
vi.mock("@/core/controller/state/awaySettings", () => ({ getAwaySettings: vi.fn() }))

const diskFault = vi.hoisted(() => ({ destination: undefined as string | undefined, attempts: 0 }))
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

function createController(stateManager?: StateManager) {
    const rebuild = vi.fn()
    const promptFlush = vi.fn()
    const state = stateManager ?? {
        mutateGlobalSettingsKey: vi.fn().mockResolvedValue("zh-CN"),
        setGlobalState: vi.fn(),
        setGlobalStateBatch: vi.fn(),
        setApiConfiguration: vi.fn(),
        setSecret: vi.fn(),
        flushPendingState: vi.fn().mockResolvedValue(undefined),
        getGlobalSettingsKey: vi.fn(),
    }
    const postStateToWebview = vi.fn(async () => undefined)
    const configureGlobalComponents = vi.fn(async () => ({ components: [], durationMs: 0 }))
    const controller = {
        stateManager: state,
        configureGlobalComponents,
        postStateToWebview,
        task: { taskId: "active-task", owners: { api: { rebuild }, prompt: { flush: promptFlush } } },
    } as unknown as Controller
    return { controller, state, rebuild, promptFlush, configureGlobalComponents, postStateToWebview }
}

afterEach(() => {
    diskFault.destination = undefined
    vi.restoreAllMocks()
    vi.clearAllMocks()
})

describe("updateSettings UI language entry and codecs", () => {
    it.each(["auto", "en", "zh-CN"] as const)("preserves %s through Settings and request codecs", (uiLanguage) => {
        const settings = Settings.fromPartial({ uiLanguage })
        expect(Settings.decode(Settings.encode(settings).finish()).uiLanguage).toBe(uiLanguage)
        expect(Settings.fromJSON(Settings.toJSON(settings)).uiLanguage).toBe(uiLanguage)
        expect(Settings.fromPartial({}).uiLanguage).toBeUndefined()
        expect(Settings.fromJSON({}).uiLanguage).toBeUndefined()
        expect(Settings.decode(new Uint8Array()).uiLanguage).toBeUndefined()
        // Append-only field identity: Settings 261, UpdateSettingsRequest 71.
        expect([...Settings.encode(settings).finish()].slice(0, 2)).toEqual([170, 16])

        const request = UpdateSettingsRequest.fromPartial({ uiLanguage })
        expect(UpdateSettingsRequest.decode(UpdateSettingsRequest.encode(request).finish()).uiLanguage).toBe(uiLanguage)
        expect(UpdateSettingsRequest.fromJSON(UpdateSettingsRequest.toJSON(request)).uiLanguage).toBe(uiLanguage)
        expect(UpdateSettingsRequest.fromPartial({}).uiLanguage).toBeUndefined()
        expect(UpdateSettingsRequest.fromJSON({}).uiLanguage).toBeUndefined()
        expect(UpdateSettingsRequest.decode(new Uint8Array()).uiLanguage).toBeUndefined()
        expect([...UpdateSettingsRequest.encode(request).finish()].slice(0, 2)).toEqual([186, 4])
    })

    it.each([
        "auto",
        "en",
        "zh-CN",
    ] as const)("commits %s through the repository mutation without runtime work", async (uiLanguage) => {
        const fixture = createController()
        const request = UpdateSettingsRequest.create({ uiLanguage, metadata: {} })
        // create() owns many keys whose values are undefined; they are not updates.
        expect(Object.keys(request).length).toBeGreaterThan(20)

        await updateSettings(fixture.controller, request)

        expect(fixture.state.mutateGlobalSettingsKey).toHaveBeenCalledWith("uiLanguage", expect.any(Function))
        const mutate = vi.mocked(fixture.state.mutateGlobalSettingsKey)
        expect(mutate.mock.calls[0][1]("auto")).toBe(uiLanguage)
        expect(fixture.state.setGlobalState).not.toHaveBeenCalled()
        expect(fixture.configureGlobalComponents).not.toHaveBeenCalled()
        expect(fixture.rebuild).not.toHaveBeenCalled()
        expect(fixture.promptFlush).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
    })

    it.each([
        "unsupported-sensitive-payload",
        "zh-cn",
        "",
        null,
        42,
        { locale: "zh-CN" },
    ])("rejects invalid language %j before every mixed-request business side effect", async (uiLanguage) => {
        const fixture = createController()
        const environment = vi.spyOn(ClineEnv, "setEnvironment")
        const log = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        const request = {
            ...UpdateSettingsRequest.create({
                awayModeEnabled: true,
                autoAwayModeEnabled: true,
                clineEnv: "staging",
                apiConfiguration: {},
                preferredLanguage: "model-language",
                chatInputSendShortcut: "ctrlEnter",
                searxngSearchToken: "test-only-token",
            }),
            uiLanguage,
        } as unknown as UpdateSettingsRequest

        await expect(updateSettings(fixture.controller, request)).rejects.toThrow("Invalid UI language preference")

        expect(fixture.state.mutateGlobalSettingsKey).not.toHaveBeenCalled()
        expect(fixture.state.setGlobalState).not.toHaveBeenCalled()
        expect(fixture.state.setGlobalStateBatch).not.toHaveBeenCalled()
        expect(fixture.state.setApiConfiguration).not.toHaveBeenCalled()
        expect(fixture.state.setSecret).not.toHaveBeenCalled()
        expect(fixture.state.flushPendingState).not.toHaveBeenCalled()
        expect(getAwaySettings).not.toHaveBeenCalled()
        expect(environment).not.toHaveBeenCalled()
        expect(accountLogoutClicked).not.toHaveBeenCalled()
        expect(fixture.configureGlobalComponents).not.toHaveBeenCalled()
        expect(fixture.rebuild).not.toHaveBeenCalled()
        expect(fixture.promptFlush).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
        expect(log).toHaveBeenCalledExactlyOnceWith("Failed to update settings:", new Error("Invalid UI language preference"))
    })

    it("still configures runtime components for a mixed non-language setting update", async () => {
        const fixture = createController()

        await updateSettings(
            fixture.controller,
            UpdateSettingsRequest.create({ uiLanguage: "en", chatInputSendShortcut: "ctrlEnter" }),
        )

        expect(fixture.state.setGlobalState).toHaveBeenCalledWith("chatInputSendShortcut", "ctrlEnter")
        expect(fixture.configureGlobalComponents).toHaveBeenCalledOnce()
        expect(fixture.promptFlush).not.toHaveBeenCalled()
        expect(fixture.rebuild).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
    })

    it("retains freshness work for represented runtime settings in a mixed request", async () => {
        const fixture = createController()

        await updateSettings(
            fixture.controller,
            UpdateSettingsRequest.create({ uiLanguage: "zh-CN", preferredLanguage: "English", mcpEnabled: false }),
        )

        expect(fixture.state.setGlobalState).toHaveBeenCalledWith("preferredLanguage", "English")
        expect(fixture.state.setGlobalState).toHaveBeenCalledWith("mcpEnabled", false)
        expect(fixture.configureGlobalComponents).toHaveBeenCalledOnce()
        expect(fixture.promptFlush).toHaveBeenCalledExactlyOnceWith("settings")
        expect(fixture.rebuild).not.toHaveBeenCalled()
    })
})

describe("updateSettings UI language durable boundary", () => {
    let root: string
    let storage: StorageContext
    let state: StateManager

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ui-language-rpc-"))
        vi.stubEnv("DLINE_DIR", root)
        vi.stubEnv("DLINE_HOME_DIR", path.join(root, "home"))
        vi.stubEnv("DLINE_DOCS_DIR", path.join(root, "documents"))
        storage = createStorageContext({ clineDir: root, workspacePath: path.join(root, "workspace") })
        await storage.globalState.update("cline.generatedMachineId", "isolated-ui-language-installation")
        await fs.writeFile(
            storage.settingsFilePath,
            JSON.stringify({ __settingsMigrationVersion: 1, uiLanguage: "en", preferredLanguage: "model-language-fixture" }),
        )
        state = await StateManager.initialize(storage)
        diskFault.attempts = 0
    })

    afterEach(async () => {
        diskFault.destination = undefined
        await StateManager.resetForTest()
        vi.unstubAllEnvs()
        await fs.rm(root, { recursive: true, force: true })
    })

    const readDocument = async (storage: StorageContext): Promise<Record<string, unknown>> =>
        JSON.parse(await fs.readFile(storage.settingsFilePath, "utf8"))

    it.each([
        "auto",
        "en",
        "zh-CN",
    ] as const)("saves and reopens %s through the real RPC and StateManager", async (uiLanguage) => {
        const fixture = createController(state)
        await updateSettings(fixture.controller, UpdateSettingsRequest.create({ uiLanguage }))

        expect(await readDocument(storage)).toMatchObject({ uiLanguage, preferredLanguage: "model-language-fixture" })
        expect(state.getUiLanguagePreference()).toBe(uiLanguage)
        expect(fixture.configureGlobalComponents).not.toHaveBeenCalled()
        expect(fixture.rebuild).not.toHaveBeenCalled()
        expect(fixture.promptFlush).not.toHaveBeenCalled()
        await StateManager.resetForTest()
        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        expect(reopened.getUiLanguagePreference()).toBe(uiLanguage)
    })

    it.each([
        "auto",
        "English",
        "Simplified Chinese - 简体中文",
    ])("saves and reopens model language %s independently of the UI locale", async (preferredLanguage) => {
        const fixture = createController(state)
        await updateSettings(fixture.controller, UpdateSettingsRequest.create({ preferredLanguage }))
        expect(await readDocument(storage)).toMatchObject({ uiLanguage: "en", preferredLanguage })
        expect(state.getUiLanguagePreference()).toBe("en")
        await StateManager.resetForTest()
        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        expect(reopened.getGlobalSettingsKey("preferredLanguage")).toBe(preferredLanguage)
        expect(reopened.getUiLanguagePreference()).toBe("en")
    })

    it("rejects an invalid composite request without changing any real store", async () => {
        const fixture = createController(state)
        const before = await readDocument(storage)
        const setGlobalState = vi.spyOn(state, "setGlobalState")
        const mutate = vi.spyOn(state, "mutateGlobalSettingsKey")
        const flush = vi.spyOn(state, "flushPendingState")

        await expect(
            updateSettings(
                fixture.controller,
                UpdateSettingsRequest.create({
                    uiLanguage: "invalid-sensitive-payload",
                    awayModeEnabled: true,
                    chatInputSendShortcut: "ctrlEnter",
                    preferredLanguage: "changed-model-language",
                    searxngSearchToken: "test-only-token",
                }),
            ),
        ).rejects.toThrow("Invalid UI language preference")

        expect(await readDocument(storage)).toEqual(before)
        expect(state.getUiLanguagePreference()).toBe("en")
        expect(state.getSecretKey("searxngSearchToken")).toBeUndefined()
        expect(setGlobalState).not.toHaveBeenCalled()
        expect(mutate).not.toHaveBeenCalled()
        expect(flush).not.toHaveBeenCalled()
        expect(getAwaySettings).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
    })

    it("publishes a local language commit to multiple consumers without reconfiguring runtime", async () => {
        const left = createController(state)
        const right = createController(state)
        const languages: string[] = []
        for (const fixture of [left, right]) {
            state.registerCallbacks({
                onSyncExternalChange: async (event) => {
                    if (event.source !== "settings") return
                    const plan = planExternalStateChange(event.source, event.commit.changedKeys)
                    if (plan.reconfigureComponents) await fixture.controller.configureGlobalComponents()
                    if (plan.publishState) {
                        languages.push(state.getUiLanguagePreference())
                        await fixture.controller.postStateToWebview()
                    }
                },
            })
        }

        await updateSettings(left.controller, UpdateSettingsRequest.create({ uiLanguage: "zh-CN" }))

        expect(languages).toEqual(["zh-CN", "zh-CN"])
        expect(left.configureGlobalComponents).not.toHaveBeenCalled()
        expect(right.configureGlobalComponents).not.toHaveBeenCalled()
        expect(right.postStateToWebview).toHaveBeenCalledOnce()
    })

    it("rejects a physical Settings write failure without dirty language or a later unrelated false publication", async () => {
        const fixture = createController(state)
        const before = await readDocument(storage)
        const publication = vi.fn()
        state.registerCallbacks({ onSyncExternalChange: publication })
        const log = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        diskFault.destination = storage.settingsFilePath

        await expect(
            updateSettings(fixture.controller, UpdateSettingsRequest.create({ uiLanguage: "zh-CN" })),
        ).rejects.toMatchObject({ code: "ENOSPC" })

        expect(diskFault.attempts).toBe(1)
        expect(await readDocument(storage)).toEqual(before)
        expect(state.getUiLanguagePreference()).toBe("en")
        expect(publication).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
        expect(fixture.configureGlobalComponents).not.toHaveBeenCalled()
        expect(log).toHaveBeenCalledOnce()

        diskFault.destination = undefined
        await updateSettings(fixture.controller, UpdateSettingsRequest.create({ chatInputSendShortcut: "ctrlEnter" }))
        expect(publication).toHaveBeenCalled()
        expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
        expect(state.getUiLanguagePreference()).toBe("en")
        expect((await readDocument(storage)).uiLanguage).toBe("en")
        await StateManager.resetForTest()
        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        expect(reopened.getUiLanguagePreference()).toBe("en")
    })

    it("keeps already-durable language when a later store in the mixed request fails", async () => {
        const fixture = createController(state)
        diskFault.destination = path.join(storage.dataDir, "secrets.json")

        await expect(
            updateSettings(
                fixture.controller,
                UpdateSettingsRequest.create({ uiLanguage: "zh-CN", searxngSearchToken: "test-only-token" }),
            ),
        ).rejects.toMatchObject({ code: "ENOSPC" })

        expect(diskFault.attempts).toBe(1)
        expect((await readDocument(storage)).uiLanguage).toBe("zh-CN")
        expect(state.getUiLanguagePreference()).toBe("zh-CN")
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()

        diskFault.destination = undefined
        await updateSettings(fixture.controller, UpdateSettingsRequest.create({ chatInputSendShortcut: "shiftEnter" }))
        expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
        expect(state.getUiLanguagePreference()).toBe("zh-CN")
        await StateManager.resetForTest()
        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        expect(reopened.getUiLanguagePreference()).toBe("zh-CN")
    })

    it("propagates a post-commit publication failure without pretending the durable preference rolled back", async () => {
        const fixture = createController(state)
        fixture.postStateToWebview.mockRejectedValueOnce(new Error("State publication failed"))

        await expect(updateSettings(fixture.controller, UpdateSettingsRequest.create({ uiLanguage: "zh-CN" }))).rejects.toThrow(
            "State publication failed",
        )

        expect((await readDocument(storage)).uiLanguage).toBe("zh-CN")
        expect(state.getUiLanguagePreference()).toBe("zh-CN")
        await updateSettings(fixture.controller, UpdateSettingsRequest.create({ chatInputSendShortcut: "ctrlEnter" }))
        expect(state.getUiLanguagePreference()).toBe("zh-CN")
        await StateManager.resetForTest()
        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        expect(reopened.getUiLanguagePreference()).toBe("zh-CN")
    })
})
