import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
    cleanupLegacyGlobalState,
    GLOBAL_STATE_CLEANUP_GENERATION,
    GLOBAL_STATE_CLEANUP_GENERATION_KEY,
} from "../globalstatecleanup"

/**
 * globalState.json accumulated three kinds of unreadable entries: Settings that
 * an older build projected into it, fields dropped from the schema, and
 * provider configuration that moved to API profiles. The sweep removes them
 * without touching the state the current partition still owns.
 */
describe("cleanupLegacyGlobalState", () => {
    let directory: string
    let filePath: string

    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "dline-globalstate-cleanup-"))
        filePath = path.join(directory, "globalState.json")
    })

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true })
    })

    async function openStore(document: Record<string, unknown>): Promise<ClineFileStorage> {
        await writeFile(filePath, JSON.stringify(document), "utf8")
        return new ClineFileStorage(filePath, "test-global-state")
    }

    async function readDocument(): Promise<Record<string, unknown>> {
        return JSON.parse(await readFile(filePath, "utf8"))
    }

    it("removes projected Settings, dropped fields and migrated provider config", async () => {
        const store = await openStore({
            // Declared GlobalState — must survive.
            version: "0.9.1",
            mcpMarketplaceEnabled: true,
            remoteRulesToggles: { "rule.md": false },
            // Settings projected by an older build.
            globalSkillsToggles: { "skill.md": false },
            telemetrySetting: "disabled",
            // Fields dropped from the schema.
            lastDismissedInfoBannerVersion: 1,
            dismissedBanners: [{ bannerId: "x", dismissedAt: 1 }],
            taskCompletionBackfillCompleted: true,
            // Provider configuration now sourced from API profiles.
            openAiBaseUrl: "https://example.invalid",
            planModeOpenAiModelId: "some-model",
        })

        const result = await cleanupLegacyGlobalState(store)
        const document = await readDocument()

        expect(result.performed).toBe(true)
        expect(document.version).toBe("0.9.1")
        expect(document.mcpMarketplaceEnabled).toBe(true)
        expect(document.remoteRulesToggles).toEqual({ "rule.md": false })
        expect(document).not.toHaveProperty("globalSkillsToggles")
        expect(document).not.toHaveProperty("telemetrySetting")
        expect(document).not.toHaveProperty("lastDismissedInfoBannerVersion")
        expect(document).not.toHaveProperty("dismissedBanners")
        expect(document).not.toHaveProperty("taskCompletionBackfillCompleted")
        expect(document).not.toHaveProperty("openAiBaseUrl")
        expect(document).not.toHaveProperty("planModeOpenAiModelId")
    })

    it("carries the legacy version tracker over to its renamed key", async () => {
        const store = await openStore({ clineVersion: "0.9.0" })

        await cleanupLegacyGlobalState(store)
        const document = await readDocument()

        // Losing this value would make the next launch look like a fresh install
        // and replay the update announcement.
        expect(document.version).toBe("0.9.0")
        expect(document).not.toHaveProperty("clineVersion")
    })

    it("keeps a current version value when both keys are present", async () => {
        const store = await openStore({ clineVersion: "0.9.0", version: "0.9.1" })

        await cleanupLegacyGlobalState(store)
        const document = await readDocument()

        expect(document.version).toBe("0.9.1")
    })

    it("keeps the migration markers that describe the store itself", async () => {
        const store = await openStore({
            __vscodeMigrationVersion: 2,
            __settingsMigrationVersion: 2,
            "cline.generatedMachineId": "machine-1",
            dismissedBanners: [],
        })

        await cleanupLegacyGlobalState(store)
        const document = await readDocument()

        expect(document.__vscodeMigrationVersion).toBe(2)
        expect(document.__settingsMigrationVersion).toBe(2)
        expect(document["cline.generatedMachineId"]).toBe("machine-1")
        expect(document).not.toHaveProperty("dismissedBanners")
    })

    it("records the applied generation and skips an already swept store", async () => {
        const store = await openStore({ dismissedBanners: [] })

        const first = await cleanupLegacyGlobalState(store)
        expect(first.performed).toBe(true)
        expect(first.removedKeys).toEqual(["dismissedBanners"])
        expect(await readDocument()).toHaveProperty(GLOBAL_STATE_CLEANUP_GENERATION_KEY, GLOBAL_STATE_CLEANUP_GENERATION)

        const second = await cleanupLegacyGlobalState(store)
        expect(second.performed).toBe(false)
        expect(second.removedKeys).toEqual([])
    })

    it("reruns when a later generation supersedes the recorded one", async () => {
        const store = await openStore({
            [GLOBAL_STATE_CLEANUP_GENERATION_KEY]: GLOBAL_STATE_CLEANUP_GENERATION - 1,
            dismissedBanners: [],
        })

        const result = await cleanupLegacyGlobalState(store)

        expect(result.performed).toBe(true)
        expect(await readDocument()).not.toHaveProperty("dismissedBanners")
    })

    it("leaves the generation marker behind when the write fails", async () => {
        const store = await openStore({ dismissedBanners: [] })
        const failure = new Error("disk unavailable")
        store.setBatchAsync = () => Promise.reject(failure)

        await expect(cleanupLegacyGlobalState(store)).rejects.toThrow(failure)
        expect(await readDocument()).not.toHaveProperty(GLOBAL_STATE_CLEANUP_GENERATION_KEY)
    })
})
