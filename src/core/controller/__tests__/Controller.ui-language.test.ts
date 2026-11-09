import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ExtensionState } from "@shared/ExtensionMessage"
import type { GetHostVersionResponse } from "@shared/proto/dline/host/env"
import { createStorageContext, type StorageContext } from "@shared/storage/storage-context"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { HostRegistryInfo } from "@/registry"
import { Controller } from "../index"

vi.unmock("@/registry")
// Away has its own safety/lifecycle suite. This fixture avoids starting that
// unrelated gate owner while exercising real language storage and state builds.
vi.mock("@/core/controller/state/awaySettingsProjection", () => ({ awaySettingsProjection: () => ({}) }))

let root: string
let storage: StorageContext

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ui-language-controller-"))
    vi.stubEnv("DLINE_DIR", root)
    vi.stubEnv("DLINE_HOME_DIR", path.join(root, "home"))
    vi.stubEnv("DLINE_DOCS_DIR", path.join(root, "documents"))
    storage = createStorageContext({ clineDir: root, workspacePath: path.join(root, "workspace") })
    await storage.globalState.update("cline.generatedMachineId", "isolated-ui-language-installation")
})

afterEach(async () => {
    await StateManager.resetForTest()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
})

interface StateBuilder {
    buildState(revision: number): Promise<ExtensionState>
}

/** Real buildState and StateManager; unrelated task/message composition is inert. */
function createBuilder(stateManager: StateManager, taskId?: string): StateBuilder {
    return Object.assign(Object.create(Controller.prototype), {
        stateManager,
        getCurrentTaskId: () => taskId,
        materializeMessageWindow: () => ({ messages: [], totalCount: 0, firstItemIndex: 0 }),
        readLocalCapabilityToggles: () => ({}),
        modeSwitchCoordinator: { getSnapshot: () => ({ phase: "idle" }) },
        getTaskLockStatus: () => undefined,
        projectCurrentTaskViewState: () => undefined,
    }) as StateBuilder
}

async function openState(uiLanguage: unknown, metadata: GetHostVersionResponse = {}): Promise<StateManager> {
    vi.spyOn(HostProvider.env, "getHostVersion").mockResolvedValue(metadata)
    await fs.writeFile(
        storage.settingsFilePath,
        JSON.stringify({
            __settingsMigrationVersion: 1,
            uiLanguage,
            preferredLanguage: "model-language-fixture",
        }),
    )
    return StateManager.initialize(storage)
}

describe("Controller UI language state projection", () => {
    it("projects preference and raw cached host metadata without resolving or repeatedly requesting it", async () => {
        const state = await openState("auto", { displayLanguage: "ZH-hant-TW", remoteName: "ssh-remote" })
        const builder = createBuilder(state)
        const metadataRequest = vi.mocked(HostProvider.env.getHostVersion)

        for (let revision = 1; revision <= 3; revision++) {
            const projected = await builder.buildState(revision)
            expect(projected).toMatchObject({
                stateRevision: revision,
                uiLanguage: "auto",
                hostDisplayLanguage: "ZH-hant-TW",
                preferredLanguage: "model-language-fixture",
            })
        }

        expect(metadataRequest).toHaveBeenCalledExactlyOnceWith({})
        expect(HostRegistryInfo.get()?.displayLanguage).toBe("ZH-hant-TW")
        const document = JSON.parse(await fs.readFile(storage.settingsFilePath, "utf8"))
        expect(document.uiLanguage).toBe("auto")
        expect(document.hostDisplayLanguage).toBeUndefined()
        expect(document.displayLanguage).toBeUndefined()
    })

    it.each(["en", "zh-CN"])("projects explicit %s independently from the host", async (uiLanguage) => {
        const state = await openState(uiLanguage, { displayLanguage: uiLanguage === "en" ? "zh-CN" : "en" })

        const projected = await createBuilder(state).buildState(1)

        expect(projected.uiLanguage).toBe(uiLanguage)
        expect(projected.hostDisplayLanguage).toBe(uiLanguage === "en" ? "zh-CN" : "en")
        expect(projected.preferredLanguage).toBe("model-language-fixture")
    })

    it("ignores legacy task, session, remote and dirty language but preserves other settings' overrides", async () => {
        const state = await openState("en", { displayLanguage: "zh-CN" })
        state.setActiveTask("historical-task")
        state.setTaskSettings("historical-task", "uiLanguage", "zh-CN")
        state.setTaskSettings("historical-task", "preferredLanguage", "task-model-language")
        state.setSessionOverride("uiLanguage", "zh-CN")
        state.setRemoteConfigField("uiLanguage", "zh-CN")
        state.setGlobalState("uiLanguage", "zh-CN")

        const projected = await createBuilder(state, "historical-task").buildState(1)

        expect(projected.uiLanguage).toBe("en")
        expect(projected.preferredLanguage).toBe("task-model-language")
        expect(projected.hostDisplayLanguage).toBe("zh-CN")
    })

    it.each([undefined, "invalid-stored-preference"])("accepts old metadata and stored preference %s", async (uiLanguage) => {
        const state = await openState(uiLanguage, { platform: "old host" })

        const projected = await createBuilder(state).buildState(1)

        expect(projected.uiLanguage).toBe("auto")
        expect(projected.hostDisplayLanguage).toBeUndefined()
        expect(HostProvider.env.getHostVersion).toHaveBeenCalledOnce()
    })

    it("keeps building state after host metadata failure without retrying on publication", async () => {
        const metadataRequest = vi.spyOn(HostProvider.env, "getHostVersion").mockRejectedValue(new Error("Host unavailable"))
        const state = await StateManager.initialize(storage)
        const builder = createBuilder(state)

        for (let revision = 1; revision <= 3; revision++) {
            const projected = await builder.buildState(revision)
            expect(projected.uiLanguage).toBe("auto")
            expect(projected.hostDisplayLanguage).toBeUndefined()
        }
        expect(metadataRequest).toHaveBeenCalledOnce()
    })

    it("projects the last committed preference even while the repository is unavailable", async () => {
        const state = await openState("zh-CN", { displayLanguage: "en" })
        await expect(
            state.mutateGlobalSettingsKey("showFeatureTips", () => {
                throw new Error("Injected repository transaction failure")
            }),
        ).rejects.toThrow("Injected repository transaction failure")
        expect(() => state.readAwaySettingsSnapshot()).toThrow("unavailable")

        const projected = await createBuilder(state).buildState(1)

        expect(projected.uiLanguage).toBe("zh-CN")
        expect(projected.hostDisplayLanguage).toBe("en")
    })

    it("retains auto across reopening and reads the new host metadata only at initialization", async () => {
        const first = await openState("auto", { displayLanguage: "zh-CN" })
        expect((await createBuilder(first).buildState(1)).hostDisplayLanguage).toBe("zh-CN")
        await StateManager.resetForTest()
        vi.mocked(HostProvider.env.getHostVersion).mockResolvedValue({ displayLanguage: "en" })

        const reopened = await StateManager.initialize(createStorageContext({ clineDir: root }))
        const projected = await createBuilder(reopened).buildState(2)

        expect(projected.uiLanguage).toBe("auto")
        expect(projected.hostDisplayLanguage).toBe("en")
        expect(HostProvider.env.getHostVersion).toHaveBeenCalledTimes(2)
        expect(JSON.parse(await fs.readFile(storage.settingsFilePath, "utf8")).uiLanguage).toBe("auto")
    })
})
