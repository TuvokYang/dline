import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const TASK_SOURCE_ROOTS = [path.resolve("src/core/task"), path.resolve("src/core/controller")] as const
const LEGACY_TASK_MARKERS = [
    "isTaskWorkingForUi",
    "findLegacyResumeAnchorMessage",
    "pendingToolUseApprovalResponse",
    "block.dlineTid ?? block.callId",
    "findLatestStateSnapshot",
    "onSnapshot: this.emitStateSnapshot",
    "runtimeCommitted = false",
    "void this.recursivelyMakeClineRequests(content)",
    "executeTool: async () => undefined",
    "await this.toolExecutor.executeTool(block)\n\t\t\t\t\tconst committedBlock",
] as const

/** Read all production TypeScript sources below one directory in stable path order. */
async function readSources(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true })
    const contents: string[] = []

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            if (entry.name !== "__tests__") {
                contents.push(await readSources(entryPath))
            }
            continue
        }
        if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            contents.push(await readFile(entryPath, "utf8"))
        }
    }

    return contents.join("\n")
}

/** Read the task and controller production source inventory. */
async function readTaskSources(): Promise<string> {
    return (await Promise.all(TASK_SOURCE_ROOTS.map((root) => readSources(root)))).join("\n")
}

describe("final task-state architecture gate", () => {
    it("removes all runtime message inference and identity fallback markers", async () => {
        const sources = await readTaskSources()

        for (const marker of LEGACY_TASK_MARKERS) {
            expect(sources).not.toContain(marker)
        }
    })
})
