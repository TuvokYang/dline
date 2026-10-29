import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveToggles } from "@core/storage/settings/capability-toggle-scopes"
import { SettingsRepository } from "@core/storage/settings/SettingsRepository"
import { createStorageContext } from "@shared/storage/storage-context"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Workspace preferences are stored in their own settings document so a
 * workspace-level write is committed with the same strong consistency as global
 * settings, instead of the delayed batch used for workspaceState.json.
 */
describe("workspace settings scope", () => {
    let clineDir: string

    beforeEach(async () => {
        clineDir = await mkdtemp(path.join(tmpdir(), "dline-workspace-settings-"))
    })

    afterEach(async () => {
        await rm(clineDir, { recursive: true, force: true })
    })

    it("places the workspace settings document beside the workspace state", () => {
        const storage = createStorageContext({ clineDir, workspacePath: "/projects/demo" })

        expect(storage.workspaceSettingsFilePath).toBe(path.join(storage.workspaceStoragePath, "settings.json"))
        expect(storage.workspaceSettingsFilePath).not.toBe(storage.settingsFilePath)
    })

    it("keeps workspace overrides out of the global settings document", async () => {
        const storage = createStorageContext({ clineDir, workspacePath: "/projects/demo" })
        const globalRepository = new SettingsRepository({ filePath: storage.settingsFilePath, watch: false })
        const workspaceRepository = new SettingsRepository({
            filePath: storage.workspaceSettingsFilePath,
            watch: false,
        })

        try {
            await globalRepository.initialize()
            await workspaceRepository.initialize()

            await globalRepository.mutateResolved(() => ({ globalSkillsToggles: { "/skills/a": false } }))
            await workspaceRepository.mutateResolved(() => ({ workspaceSkillsToggles: { "/skills/a": true } }))

            const globalDocument = JSON.parse(await readFile(storage.settingsFilePath, "utf8"))
            const workspaceDocument = JSON.parse(await readFile(storage.workspaceSettingsFilePath, "utf8"))

            expect(globalDocument.workspaceSkillsToggles).toBeUndefined()
            expect(workspaceDocument.globalSkillsToggles).toBeUndefined()
            expect(workspaceDocument.workspaceSkillsToggles).toEqual({ "/skills/a": true })

            // The workspace override wins over the global preference.
            expect(
                resolveToggles(
                    { "/skills/a": true },
                    {
                        global: globalRepository.readSnapshot().values.globalSkillsToggles,
                        workspace: workspaceRepository.readSnapshot().values.workspaceSkillsToggles,
                    },
                ),
            ).toEqual({ "/skills/a": true })
        } finally {
            await Promise.all([globalRepository.dispose(), workspaceRepository.dispose()])
        }
    })

    it("isolates preferences between two workspaces", () => {
        const first = createStorageContext({ clineDir, workspacePath: "/projects/first" })
        const second = createStorageContext({ clineDir, workspacePath: "/projects/second" })

        expect(first.workspaceSettingsFilePath).not.toBe(second.workspaceSettingsFilePath)
    })
})
