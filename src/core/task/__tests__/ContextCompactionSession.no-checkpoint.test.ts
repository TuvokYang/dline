import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("ContextCompactionSession recovery-store boundary", () => {
    it("does not expose compact checkpoint, head, journal, or restore handshake concepts", async () => {
        const source = await fs.readFile(path.resolve("src/core/task/ContextCompactionSession.ts"), "utf8")
        for (const forbidden of [
            "CompactionCheckpointHead",
            "prepareRootCheckpoint",
            "checkpointAcceptedPass",
            "ContextCompactionSessionRestoreRequest",
            "restore_pending",
            "awaiting_adoption",
        ]) {
            expect(source).not.toContain(forbidden)
        }
    })
})
