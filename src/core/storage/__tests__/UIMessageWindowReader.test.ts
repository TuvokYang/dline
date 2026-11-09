import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeJsonl } from "@/core/storage/backend/jsonl/jsonl-utils"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { UiMessageRowStore } from "@/core/storage/messages/UiMessageRowStore"
import { UIMessage } from "@/core/storage/UIMessage"

describe("UIMessage history windows", () => {
    let dlineDocsDir: string

    beforeEach(async () => {
        dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ui-window-"))
        vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await fs.rm(dlineDocsDir, { recursive: true, force: true })
    })

    it("reads absolute pages without retaining the whole canonical JSONL body", async () => {
        const taskId = "window-pages"
        const messages = Array.from(
            { length: 600 },
            (_, index): UiMessage => ({
                ts: index + 1,
                type: "say",
                say: index === 0 ? "task" : "text",
                text: `${index}:`.padEnd(8 * 1024, "x"),
            }),
        )
        const writer = await UIMessage.open(taskId)
        await writer.overwrite(messages)
        await writer.close()

        const reader = await UIMessage.openWindow(taskId)
        try {
            expect(reader.count).toBe(600)
            expect((await reader.getLatest(20)).map((message) => message.ts)).toEqual(
                Array.from({ length: 20 }, (_, index) => 581 + index),
            )
            await expect(reader.getPage(100, 3)).resolves.toMatchObject({
                startIndex: 100,
                totalCount: 600,
                messages: [{ ts: 101 }, { ts: 102 }, { ts: 103 }],
            })
            await expect(reader.getByTimestamp(350)).resolves.toMatchObject({ ts: 350 })
        } finally {
            await reader.close()
        }
    })

    it("keeps the last duplicate timestamp in its final logical position", async () => {
        const taskId = "window-dedup"
        const taskDirectory = await ensureTaskDirectoryExists(taskId)
        await writeJsonl(path.join(taskDirectory, GlobalFileNames.uiMessages), [
            { ts: 10, type: "say", say: "text", text: "old" },
            { ts: 20, type: "say", say: "text", text: "middle" },
            { ts: 10, type: "say", say: "text", text: "final" },
        ])

        const reader = await UIMessage.openWindow(taskId)
        try {
            expect(reader.count).toBe(2)
            expect((await reader.getPage(0, 2)).messages.map((message) => [message.ts, message.text])).toEqual([
                [20, "middle"],
                [10, "final"],
            ])
        } finally {
            await reader.close()
        }
    })

    it("finds the last ask an interaction revealed in stored rows and in a not-yet-imported legacy file", async () => {
        const rows: UiMessage[] = [
            { ts: 10, type: "ask", ask: "tool", text: "first reveal", interactionId: "interaction-1" },
            { ts: 20, type: "ask", ask: "tool", text: "final reveal", interactionId: "interaction-1" },
            { ts: 30, type: "say", say: "text", text: "answer", interactionId: "interaction-1" },
        ]
        const writer = await UIMessage.open("window-ask-rows")
        await writer.overwrite(rows)
        await writer.close()
        const legacyDirectory = await ensureTaskDirectoryExists("window-ask-legacy")
        await writeJsonl(path.join(legacyDirectory, GlobalFileNames.uiMessages), rows)

        for (const taskId of ["window-ask-rows", "window-ask-legacy"]) {
            const reader = await UIMessage.openWindow(taskId)
            try {
                await expect(reader.getLastAsk("interaction-1")).resolves.toMatchObject({ ts: 20, text: "final reveal" })
                await expect(reader.getLastAsk("interaction-missing")).resolves.toBeUndefined()
            } finally {
                await reader.close()
            }
        }
    })

    it("ignores transient partial rows while keeping the complete row with the same timestamp", async () => {
        const taskId = "window-partial"
        const taskDirectory = await ensureTaskDirectoryExists(taskId)
        await writeJsonl(path.join(taskDirectory, GlobalFileNames.uiMessages), [
            { ts: 10, type: "say", say: "text", text: "partial", partial: true },
            { ts: 10, type: "say", say: "text", text: "final", partial: false },
            { ts: 20, type: "say", say: "text", text: "abandoned", partial: true },
        ])

        const reader = await UIMessage.openWindow(taskId)
        try {
            expect(reader.count).toBe(2)
            expect((await reader.getPage(0, 10)).messages).toEqual([
                expect.objectContaining({ ts: 10, text: "final", partial: false }),
                expect.objectContaining({ ts: 20, text: "abandoned", partial: true }),
            ])
        } finally {
            await reader.close()
        }
    })

    it("promotes a legacy scalar checkpoint hash while reading a not-yet-imported file", async () => {
        const taskId = "window-legacy-checkpoint"
        const taskDirectory = await ensureTaskDirectoryExists(taskId)
        await writeJsonl(path.join(taskDirectory, GlobalFileNames.uiMessages), [
            { ts: 10, type: "say", say: "checkpoint_created", lastCheckpointHash: "abc123" },
        ])

        const reader = await UIMessage.openWindow(taskId)
        try {
            await expect(reader.getByTimestamp(10)).resolves.toMatchObject({ lastCheckpointHash: ["abc123"] })
        } finally {
            await reader.close()
        }
    })

    it("does not create a missing Task directory or database for display-only access", async () => {
        const taskId = "missing-readonly-history"
        const reader = await UIMessage.openWindow(taskId)
        expect(reader.count).toBe(0)
        await reader.close()
        await expect(fs.access(path.join(dlineDocsDir, "tasks", taskId))).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("does not create messages.db when reading an existing task that has only a legacy file", async () => {
        const taskId = "legacy-only-history"
        const taskDirectory = await ensureTaskDirectoryExists(taskId)
        await writeJsonl(path.join(taskDirectory, GlobalFileNames.uiMessages), [
            { ts: 10, type: "say", say: "text", text: "old" },
        ])

        const reader = await UIMessage.openWindow(taskId)
        try {
            expect(reader.count).toBe(1)
        } finally {
            await reader.close()
        }
        expect((await fs.readdir(taskDirectory)).filter((name) => name.startsWith("messages.db"))).toEqual([])
    })

    it("serves the whole of a long not-yet-imported legacy JSONL history at its absolute positions", async () => {
        const taskId = "large-legacy-window"
        const taskDirectory = await ensureTaskDirectoryExists(taskId)
        const legacyFile = path.join(taskDirectory, GlobalFileNames.uiMessages)
        const OLD_ASK_TS = 11
        await writeJsonl(
            legacyFile,
            Array.from({ length: 1_000 }, (_, index) => {
                const ts = index + 1
                if (ts === OLD_ASK_TS) return { ts, type: "ask", ask: "followup", interactionId: "old-ask", text: "?" }
                return { ts, type: "say", say: index === 0 ? "task" : "text", text: `message-${ts}` }
            }),
        )

        const reader = await UIMessage.openWindow(taskId)
        try {
            expect(reader.count).toBe(1_000)
            await expect(reader.getPage(0, 1)).resolves.toMatchObject({ messages: [{ ts: 1, say: "task" }] })
            const middle = await reader.getPage(500, 3)
            expect(middle.startIndex).toBe(500)
            expect(middle.totalCount).toBe(1_000)
            expect(middle.messages.map((message) => message.ts)).toEqual([501, 502, 503])
            expect((await reader.getLatest(200)).map((message) => message.ts)).toEqual(
                Array.from({ length: 200 }, (_, index) => 801 + index),
            )
            await expect(reader.ordinalOfTimestamp(5)).resolves.toBe(4)
            await expect(reader.getLastAsk("old-ask")).resolves.toMatchObject({ ts: OLD_ASK_TS })
        } finally {
            await reader.close()
        }
        // Reading is not the import: the file keeps its name and no database appears.
        await expect(fs.access(legacyFile)).resolves.toBeUndefined()
        expect((await fs.readdir(taskDirectory)).filter((name) => name.startsWith("messages.db"))).toEqual([])
    })

    describe("committed source-index metadata", () => {
        it("keeps task0 and source metadata on latest, reference, timestamp and interaction reads", async () => {
            const writer = await UIMessage.open("source-index-window")
            await writer.overwrite(
                Array.from(
                    { length: 260 },
                    (_, index): UiMessage => ({
                        ts: index === 20 ? 900 : index + 1,
                        type: index === 20 ? "ask" : "say",
                        ...(index === 20
                            ? { ask: "tool", interactionId: "outside-window" }
                            : { say: index === 0 ? "task" : "text" }),
                        text: `source-${index}`,
                    }),
                ),
            )
            await writer.close()
            const reader = await UIMessage.openWindow("source-index-window")
            const read = vi.spyOn(UiMessageRowStore.prototype, "readRange")
            const timestamp = vi.spyOn(UiMessageRowStore.prototype, "findLastByTimestamp")
            try {
                await expect(reader.getBySourceIndex(20)).resolves.toMatchObject({ ts: 900, messageIndex: 20, text: "source-20" })
                expect(read.mock.calls).toEqual([[20, 21]])
                expect(timestamp).not.toHaveBeenCalled()
                await expect(reader.getBySourceIndex(0)).resolves.toMatchObject({ ts: 1, say: "task", messageIndex: 0 })
                await expect(reader.getBySourceIndex(260)).resolves.toBeUndefined()
                await expect(reader.getBySourceIndex(-1)).resolves.toBeUndefined()
                await expect(reader.getBySourceIndex(0.5)).resolves.toBeUndefined()
                await expect(reader.getPage(0, 1)).resolves.toMatchObject({ startIndex: 0, messages: [{ messageIndex: 0 }] })
                expect((await reader.getLatest(2)).map((message) => [message.ts, message.messageIndex])).toEqual([
                    [259, 258],
                    [260, 259],
                ])
                await expect(reader.getByTimestamp(900)).resolves.toMatchObject({ messageIndex: 20 })
                await expect(reader.getLastAsk("outside-window")).resolves.toMatchObject({ messageIndex: 20 })
            } finally {
                await reader.close()
            }
            await expect(reader.getBySourceIndex(0)).rejects.toThrow("UIMessageWindowReader is closed")
        })

        it("uses returned record ordinals, not the requested start plus output offset", async () => {
            const writer = await UIMessage.open("ordinal-records")
            await writer.overwrite(
                Array.from({ length: 80 }, (_, index): UiMessage => ({ ts: index + 1, type: "say", say: "text" })),
            )
            await writer.close()
            const reader = await UIMessage.openWindow("ordinal-records")
            try {
                // Emulate a row change between the count and page reads: only these
                // returned records carry their source positions, not the page offset.
                vi.spyOn(UiMessageRowStore.prototype, "readRange").mockResolvedValueOnce([
                    { ordinal: 61, ts: 62, message: { ts: 62, type: "say", say: "text" } },
                    { ordinal: 63, ts: 64, message: { ts: 64, type: "say", say: "text" } },
                ])
                const page = await reader.getPage(60, 4)
                expect(page.startIndex).toBe(60)
                expect(page.messages.map((message) => [message.ts, message.messageIndex])).toEqual([
                    [62, 61],
                    [64, 63],
                ])
            } finally {
                await reader.close()
            }
        })

        it("does not manufacture source indexes, import legacy rows or create missing storage", async () => {
            const taskDirectory = await ensureTaskDirectoryExists("legacy-source-index")
            const legacyFile = path.join(taskDirectory, GlobalFileNames.uiMessages)
            await writeJsonl(legacyFile, [{ ts: 10, type: "say", say: "task", text: "legacy", messageIndex: 99 }])
            const before = await fs.readFile(legacyFile, "utf8")
            const reader = await UIMessage.openWindow("legacy-source-index")
            try {
                expect(reader.canonicalIndexes).toBe(false)
                await expect(reader.getBySourceIndex(0)).resolves.toBeUndefined()
                expect((await reader.getPage(0, 1)).messages).toEqual([{ ts: 10, type: "say", say: "task", text: "legacy" }])
                await expect(reader.getByTimestamp(10)).resolves.toMatchObject({ text: "legacy" })
                expect(await reader.getByTimestamp(10)).not.toHaveProperty("messageIndex")
            } finally {
                await reader.close()
            }
            expect(await fs.readFile(legacyFile, "utf8")).toBe(before)
            expect((await fs.readdir(taskDirectory)).filter((name) => name.startsWith("messages"))).toEqual([])
            const missing = await UIMessage.openWindow("missing-source-index")
            try {
                await expect(missing.getBySourceIndex(0)).resolves.toBeUndefined()
            } finally {
                await missing.close()
            }
            await expect(fs.access(path.join(dlineDocsDir, "tasks", "missing-source-index"))).rejects.toMatchObject({
                code: "ENOENT",
            })
        })
    })

    it("uses a bounded reader for new tasks and rejects reads after close", async () => {
        const reader = await UIMessage.openWindow("window-close")
        expect(reader.count).toBe(0)
        await reader.close()
        await reader.close()
        await expect(reader.getPage(-1, 20)).rejects.toThrow("UIMessageWindowReader is closed")
    })
})
