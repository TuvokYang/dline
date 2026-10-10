import assert from "node:assert/strict"
import * as path from "node:path"
import { describe, it } from "vitest"
import { DlineRuntimeFileManager } from "./DlineRuntimeFileManager"

describe("DlineRuntimeFileManager", () => {
    it("owns the Dline system temp directory", () => {
        assert.equal(path.basename(DlineRuntimeFileManager.getTempDir()), "dline")
    })

    it("initializes the managed temp directory before command execution", () => {
        DlineRuntimeFileManager.initialize()
        assert.equal(DlineRuntimeFileManager.isManagedPath(DlineRuntimeFileManager.getTempDir()), true)
    })

    it("uses the supplied stable identity as the exact log filename stem", () => {
        const filePath = DlineRuntimeFileManager.createTempFilePath("command_100_1")

        assert.equal(path.dirname(filePath), DlineRuntimeFileManager.getTempDir())
        assert.equal(path.basename(filePath), "command_100_1.log")
    })

    it("recognizes only the Dline temp directory and its descendants", () => {
        const tempDir = DlineRuntimeFileManager.getTempDir()

        assert.equal(DlineRuntimeFileManager.isManagedPath(tempDir), true)
        assert.equal(DlineRuntimeFileManager.isManagedPath(path.join(tempDir, "nested", "output.log")), true)
        assert.equal(DlineRuntimeFileManager.isManagedPath(path.join(tempDir, "..", "cline", "output.log")), false)
        assert.equal(DlineRuntimeFileManager.isManagedPath(`${tempDir}-other`), false)
        assert.equal(DlineRuntimeFileManager.isManagedPath(path.dirname(tempDir)), false)
    })
})
