import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeJsonl } from "@/core/storage/backend/jsonl/jsonl-utils"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { UIMessage } from "@/core/storage/UIMessage"

describe("UIMessage history windows", () => {
    let dlineDocsDir: string

    beforeEach(async () => {
        dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ui-window-"))
        vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
    })

    afterEach(async () => {
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

    it("opens a large legacy JSONL history from a bounded title and tail window", async () => {
        const taskId = "large-legacy-window"
        const taskDirectory = await ensureTaskDirectoryExists(taskId)
        const legacyFile = path.join(taskDirectory, GlobalFileNames.uiMessages)
        await writeJsonl(
            legacyFile,
            Array.from({ length: 1_000 }, (_, index) => ({
                ts: index + 1,
                type: "say",
                say: index === 0 ? "task" : "text",
                text: `message-${index + 1}`,
            })),
        )
        const fullRead = vi.spyOn(fs, "readFile")

        const reader = await UIMessage.openWindow(taskId)
        try {
            expect(reader.count).toBe(401)
            await expect(reader.getPage(0, 1)).resolves.toMatchObject({ messages: [{ ts: 1, say: "task" }] })
            expect((await reader.getLatest(200)).map((message) => message.ts)).toEqual(
                Array.from({ length: 200 }, (_, index) => 801 + index),
            )
            expect(fullRead).not.toHaveBeenCalledWith(legacyFile, "utf8")
        } finally {
            await reader.close()
        }
    })

    it("uses a bounded reader for new tasks and rejects reads after close", async () => {
        const reader = await UIMessage.openWindow("window-close")
        expect(reader.count).toBe(0)
        await reader.close()
        await reader.close()
        await expect(reader.getPage(-1, 20)).rejects.toThrow("UIMessageWindowReader is closed")
    })
})
