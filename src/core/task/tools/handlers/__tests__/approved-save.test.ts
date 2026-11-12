import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { FileEditProvider } from "@integrations/editor/FileEditProvider"
import { DlineDefaultTool } from "@shared/tools"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import "../../utils/ToolHookUtils"
import { WriteToFileToolHandler } from "../WriteToFileToolHandler"

vi.mock("@utils/path", async () => {
    const actual = await vi.importActual<typeof import("@utils/path")>("@utils/path")
    return { ...actual, isLocatedInWorkspace: vi.fn().mockResolvedValue(true) }
})
vi.mock("@/services/telemetry", () => ({
    telemetryService: { captureToolUsage: vi.fn(), captureDiffEditFailure: vi.fn() },
}))
vi.mock("../../utils/AiOutputTelemetry", () => ({
    captureAccepted: vi.fn(),
    getModelInfo: () => ({ providerId: "test-provider", modelId: "test-model" }),
}))

/** Keep the real parser/editor pipeline; only replace the host's physical save port. */
class DiskEditProvider extends FileEditProvider {
    protected override async saveDocument(): Promise<boolean> {
        if (!this.absolutePath || this.documentContent === undefined) return false
        await fs.writeFile(this.absolutePath, this.documentContent, "utf8")
        return true
    }
}

function createConfig(cwd: string): TaskConfig {
    return {
        cwd,
        api: { getModel: () => ({ id: "test-model", info: {} }) },
        services: {
            stateManager: { getGlobalSettingsKey: () => false },
            diffViewProvider: new DiskEditProvider(),
            taskFileTracker: { trackModification: vi.fn() },
            fileContextTracker: {
                markFileAsEditedByCline: vi.fn(),
                trackFileContext: vi.fn(),
                settleClineEdit: vi.fn(),
            },
        },
        taskState: { consecutiveMistakeCount: 2, fileReadCache: new Map(), didEditFile: false },
        callbacks: { say: vi.fn().mockResolvedValue(undefined) },
    } as unknown as TaskConfig
}

describe("approved file saves", () => {
    beforeEach(() => {
        vi.spyOn(HostProvider, "workspace", "get").mockReturnValue({
            getWorkspacePaths: async () => ({ paths: [] }),
            saveOpenDocumentIfDirty: async () => ({}),
            getDiagnostics: async () => ({ fileDiagnostics: [] }),
        } as never)
    })
    afterEach(() => vi.restoreAllMocks())

    it.each([
        DlineDefaultTool.FILE_EDIT,
        DlineDefaultTool.FILE_NEW,
    ])("persists %s without an artificial approval delay", async (name) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "approved-save-"))
        const file = path.join(root, "sample.txt")
        await fs.writeFile(file, "before\n", "utf8")
        const config = createConfig(root)
        const handler = new WriteToFileToolHandler(new ToolValidator({ validateAccess: () => true } as never))
        const block = {
            type: "tool_use",
            name,
            partial: false,
            ts: 7,
            params:
                name === DlineDefaultTool.FILE_EDIT
                    ? { path: "sample.txt", diff: "------- SEARCH\nbefore\n=======\nafter\n+++++++ REPLACE" }
                    : { path: "sample.txt", content: "after\n" },
        } as ToolUse
        const execution = handler.execute(config, block)
        const settled = execution.then(
            () => undefined,
            () => undefined,
        )
        try {
            // The existing diff animation may settle, but no multi-second sleep may gate durability.
            await expect.poll(() => fs.readFile(file, "utf8"), { timeout: 1_500 }).toBe("after\n")
            await execution
            expect(config.taskState.didEditFile).toBe(true)
            expect(config.taskState.consecutiveMistakeCount).toBe(0)
        } finally {
            await settled
            await execution.finally(() => fs.rm(root, { recursive: true, force: true }))
        }
    })
})
