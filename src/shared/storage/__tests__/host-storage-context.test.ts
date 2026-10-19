import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const documentsLookup = vi.hoisted(() => ({ systemDocuments: "" }))

// The system Documents folder is resolved by a child process; answer it with a
// folder that deliberately differs from `~/Documents`, as a relocated one does.
vi.mock("@packages/execa", () => ({
    execa: vi.fn(async () => ({ stdout: `${documentsLookup.systemDocuments}\r\n` })),
}))

describe("createHostStorageContext", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    let sandbox: string

    beforeEach(async () => {
        sandbox = await mkdtemp(path.join(os.tmpdir(), "dline-host-storage-context-"))
        documentsLookup.systemDocuments = path.join(sandbox, "Relocated Documents")
        vi.stubEnv("DLINE_DOCS_DIR", "")
        vi.stubEnv("DLINE_DIR", path.join(sandbox, "state"))
        Object.defineProperty(process, "platform", { value: "win32" })
        // The Documents root is cached per module instance; start every case unresolved.
        vi.resetModules()
    })

    afterEach(async () => {
        if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
        vi.unstubAllEnvs()
        await rm(sandbox, { recursive: true, force: true })
    })

    it("keeps the task history index beside the task directories in a relocated Documents folder", async () => {
        const { createHostStorageContext } = await import("../storage-context")
        const { getDlineDocumentsPath } = await import("@core/storage/documents-path")

        const storage = await createHostStorageContext({ workspacePath: path.join(sandbox, "workspace") })

        const expectedTasksDir = path.join(documentsLookup.systemDocuments, "dline", "tasks")
        expect(storage.taskHistoryDatabasePath).toBe(path.join(expectedTasksDir, "taskHistory.db"))
        expect(storage.taskHistoryPath).toBe(path.join(expectedTasksDir, "taskHistory.jsonl"))
        // Task directories resolve through the asynchronous root; the index must agree with it.
        expect(path.dirname(storage.taskHistoryDatabasePath)).toBe(path.join(await getDlineDocumentsPath(), "tasks"))
    })
})
