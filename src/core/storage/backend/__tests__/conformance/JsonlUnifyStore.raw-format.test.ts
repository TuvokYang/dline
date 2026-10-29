import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

interface RawItem {
    ts: number
    value: string
}

describe("buffered JSONL raw format", () => {
    it("persists original business items without entity wrapper fields", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-raw-jsonl-"))
        const filePath = path.join(root, "items.jsonl")
        try {
            const writer = await openBufferedJsonlStore<RawItem>(filePath, {
                schemaId: "raw-jsonl-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            await writer.append({ ts: 100, value: "raw" })
            await writer.close()

            const content = await fs.readFile(filePath, "utf8")
            expect(content).toBe(`${JSON.stringify({ ts: 100, value: "raw" })}\n`)
            expect(content).not.toContain("ordinal")
            expect(content).not.toContain("timestamp")
            expect(content).not.toContain("payload")

            const reopened = await openBufferedJsonlStore<RawItem>(filePath, {
                schemaId: "raw-jsonl-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            expect(reopened.getAll()).toEqual([{ ts: 100, value: "raw" }])
            await reopened.close()
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })
})
