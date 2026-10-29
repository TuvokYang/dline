import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readTaskSettingsFromStorage, writeTaskSettingsToStorage } from "../disk"

const renameGate = vi.hoisted(() => ({
    /** Awaited before a rename whose destination equals this path. */
    pauseBeforePublishing: undefined as { destination: string; reached: () => void; release: Promise<void> } | undefined,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>()
    const rename: typeof actual.rename = async (source, destination) => {
        const gate = renameGate.pauseBeforePublishing
        if (gate && String(destination) === gate.destination) {
            renameGate.pauseBeforePublishing = undefined
            gate.reached()
            await gate.release
        }
        return actual.rename(source, destination)
    }
    return { ...actual, default: { ...actual, rename }, rename }
})

describe("Task settings atomic persistence", () => {
    let originalDocsDir: string | undefined
    let temporaryDirectory: string

    beforeEach(async () => {
        originalDocsDir = process.env.DLINE_DOCS_DIR
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-task-settings-atomicity-"))
        process.env.DLINE_DOCS_DIR = temporaryDirectory
    })

    afterEach(async () => {
        renameGate.pauseBeforePublishing = undefined
        vi.restoreAllMocks()
        if (originalDocsDir === undefined) delete process.env.DLINE_DOCS_DIR
        else process.env.DLINE_DOCS_DIR = originalDocsDir
        await fs.rm(temporaryDirectory, { recursive: true, force: true })
    })

    it("keeps the committed Task settings readable while the next write is in progress", async () => {
        const taskId = "atomic-task-settings"
        await writeTaskSettingsToStorage(taskId, {
            actModeReasoningOverrideKind: "effort",
            actModeReasoningOverrideEffort: "low",
        })

        const settingsPath = path.join(temporaryDirectory, "tasks", taskId, "settings.json")
        let releaseWrite: (() => void) | undefined
        const writePaused = new Promise<void>((resolve) => {
            releaseWrite = resolve
        })
        let observedWrite: (() => void) | undefined
        const writeObserved = new Promise<void>((resolve) => {
            observedWrite = resolve
        })
        renameGate.pauseBeforePublishing = {
            destination: settingsPath,
            reached: () => observedWrite?.(),
            release: writePaused,
        }

        const update = writeTaskSettingsToStorage(taskId, {
            actModeReasoningOverrideEffort: "medium",
        })
        await writeObserved

        await expect(readTaskSettingsFromStorage(taskId)).resolves.toMatchObject({
            actModeReasoningOverrideKind: "effort",
            actModeReasoningOverrideEffort: "low",
        })

        releaseWrite?.()
        await update
        await expect(readTaskSettingsFromStorage(taskId)).resolves.toMatchObject({
            actModeReasoningOverrideKind: "effort",
            actModeReasoningOverrideEffort: "medium",
        })
        expect(await fs.readFile(settingsPath, "utf8")).toMatch(/\n$/)
        expect((await fs.readdir(path.dirname(settingsPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
})
