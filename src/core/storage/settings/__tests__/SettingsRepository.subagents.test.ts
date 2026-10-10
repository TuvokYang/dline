import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SettingsRepository } from "../SettingsRepository"

const temporaryDirectories: string[] = []
const repositories: SettingsRepository[] = []

async function createSettingsFile(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-subagent-settings-"))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, "settings.json")
    await fs.writeFile(filePath, `${JSON.stringify({ subagentsEnabled: false, mcpEnabled: true }, null, 2)}\n`, "utf8")
    return filePath
}

async function openRepository(filePath: string, sourceId: string): Promise<SettingsRepository> {
    const repository = new SettingsRepository({ filePath, sourceId, watch: false })
    repositories.push(repository)
    await repository.initialize()
    return repository
}

afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.dispose()))
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("SettingsRepository Subagents consistency", () => {
    it("preserves enabled Subagents when a stale instance commits an unrelated setting", async () => {
        const filePath = await createSettingsFile()
        const enablingInstance = await openRepository(filePath, "enabling-instance")
        const staleInstance = await openRepository(filePath, "stale-instance")

        await enablingInstance.mutate({ subagentsEnabled: true })
        await staleInstance.mutate({ mcpEnabled: false })

        const document = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>
        expect(document.subagentsEnabled).toBe(true)
        expect(document.mcpEnabled).toBe(false)
        expect(document.__settingsRepositoryRevision).toBe(2)
    })
})
