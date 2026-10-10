import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { TaskLegacyStorageCleaner } from "../TaskLegacyStorageCleaner"

describe("TaskLegacyStorageCleaner", () => {
    it("removes only the exact context-compaction-recovery directory", async () => {
        const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-legacy-cleaner-"))
        const legacyDir = path.join(taskDir, "context-compaction-recovery")
        const similarDir = path.join(taskDir, "context-compaction-recovery-backup")
        try {
            await fs.mkdir(path.join(legacyDir, "artifacts"), { recursive: true })
            await fs.writeFile(path.join(legacyDir, "artifacts", "old.json"), "legacy")
            await fs.mkdir(similarDir)

            const cleaner = new TaskLegacyStorageCleaner()
            await expect(cleaner.cleanLockedTask(taskDir)).resolves.toEqual({
                removed: ["context-compaction-recovery"],
                failed: [],
            })
            await expect(fs.access(legacyDir)).rejects.toMatchObject({ code: "ENOENT" })
            await expect(fs.access(similarDir)).resolves.toBeUndefined()
        } finally {
            await fs.rm(taskDir, { recursive: true, force: true })
        }
    })

    it("reports deletion failures without rejecting locked Task preparation", async () => {
        const failure = new Error("directory is busy")
        const cleaner = new TaskLegacyStorageCleaner(async () => {
            throw failure
        })

        await expect(cleaner.cleanLockedTask("task-directory")).resolves.toEqual({
            removed: [],
            failed: [{ name: "context-compaction-recovery", error: failure }],
        })
    })
})
