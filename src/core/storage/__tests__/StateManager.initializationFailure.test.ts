import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createStorageContext } from "@shared/storage/storage-context"
import { afterEach, describe, expect, it } from "vitest"
import { StateManager } from "../StateManager"

let temporaryDirectory: string | undefined

afterEach(async () => {
    await StateManager.resetForTest()
    if (temporaryDirectory) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true })
        temporaryDirectory = undefined
    }
})

describe("StateManager initialization failure", () => {
    it("does not publish a partially initialized singleton and permits a clean retry", async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-state-init-failure-"))
        const storage = createStorageContext({ clineDir: temporaryDirectory })

        await fs.rm(storage.settingsFilePath, { force: true })
        await fs.mkdir(storage.settingsFilePath, { recursive: true })

        await expect(StateManager.initialize(storage)).rejects.toBeDefined()
        expect(() => StateManager.get()).toThrow("StateManager has not been initialized")

        await fs.rm(storage.settingsFilePath, { recursive: true, force: true })
        const recovered = await StateManager.initialize(createStorageContext({ clineDir: temporaryDirectory }))

        expect(StateManager.get()).toBe(recovered)
    })
})
