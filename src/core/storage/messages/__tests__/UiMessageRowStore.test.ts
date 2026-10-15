import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { closeInstanceStoragesUnder, ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../../instance"
import { UI_MESSAGE_ORDINAL, UiMessageRowStore } from "../UiMessageRowStore"
import { decodeUiMessage, encodeUiMessage, type UiMessageRecord } from "../UiMessageRows"

const richMessage = {
    ts: 1_700_000_000_123,
    type: "say",
    say: "text",
    text: "hello",
    images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
    files: ["/tmp/a.txt"],
    partial: false,
    exitCode: 0,
    commandTs: 1_700_000_000_000.5,
    conversationHistoryDeletedRange: [2, 5],
    modelInfo: { providerId: "openai", modelId: "gpt", mode: "act" },
    // A field this schema does not know must survive untouched.
    futureField: { nested: [1, "two"] },
    // A value its column cannot hold goes to `extra` instead of being coerced.
    exitCodeAsText: undefined,
} as unknown as UiMessage

function record(message: UiMessage, ordinal: number): UiMessageRecord {
    return { ordinal, ts: message.ts, message }
}

describe("UI message rows", () => {
    it("round-trips every field, including unknown ones and attachment order", () => {
        const { row, attachments } = encodeUiMessage(richMessage, 3)
        expect(attachments.map((attachment) => attachment.key)).toEqual(["3:images:0", "3:images:1", "3:files:0"])
        const { exitCodeAsText: _dropped, ...expected } = richMessage as unknown as Record<string, unknown>
        expect(decodeUiMessage(row, [...attachments].reverse())).toEqual(expected)
    })

    it("keeps a value that does not fit its column in extra", () => {
        const message = { ts: 5, type: "ask", ask: "followup", exitCode: "7", images: [] } as unknown as UiMessage
        const { row, attachments } = encodeUiMessage(message, 0)
        expect(row.exitCode).toBeNull()
        expect(row.extra).toEqual({ exitCode: "7", images: [] })
        expect(attachments).toEqual([])
        expect(decodeUiMessage(row, attachments)).toEqual(message)
    })

    it("persists checkpoint source identity through the schema-compatible extra document", () => {
        const message: UiMessage = {
            ts: 55,
            type: "say",
            say: "checkpoint_created",
            checkpointSource: {
                kind: "pre_edit",
                toolTs: 54,
                toolName: "replace_in_file",
                dlineTid: "tool-54",
            },
        }

        const { row, attachments } = encodeUiMessage(message, 2)

        expect(row.extra).toEqual({ checkpointSource: message.checkpointSource })
        expect(decodeUiMessage(row, attachments)).toEqual(message)
    })

    it("keeps the facts a user row was submitted with without a schema change", () => {
        const message = {
            ts: 6,
            type: "say",
            say: "user_feedback",
            text: "/compact then /explain-changes",
            submittedInputs: [
                {
                    segments: [
                        { text: "/compact", role: "command", active: true },
                        { text: " then ", role: "text", active: false },
                        { text: "/explain-changes", role: "command", active: false },
                    ],
                },
            ],
        } as unknown as UiMessage
        const { row, attachments } = encodeUiMessage(message, 1)
        expect(row.extra).toEqual({ submittedInputs: message.submittedInputs })
        expect(decodeUiMessage(row, attachments)).toEqual(message)
    })
})

describe("UiMessageRowStore", () => {
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-messages-db-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
    })

    afterEach(async () => {
        await closeInstanceStoragesUnder(documentsRoot)
        vi.unstubAllEnvs()
        await rm(documentsRoot, { recursive: true, force: true })
    })

    async function openStore(taskId: string) {
        const layout = await ensureInstanceLayout({ taskId })
        const storage = openInstanceStorage(layout.root)
        const database = await storage.openDatabase(InstanceDatabase.Messages, "ui-message-projection")
        return UiMessageRowStore.open(database, () => storage.close())
    }

    it("persists rows and attachments together and reads them back after reopening", async () => {
        const first = await openStore("task-rows")
        const second = { ts: richMessage.ts, type: "say", say: "text", text: "same timestamp" } as UiMessage
        await first.insert([record(richMessage, 0)])
        await first.insert([record(second, 1)])
        await first.close()

        const reopened = await openStore("task-rows")
        const { records } = await reopened.query({ orderBy: [{ field: UI_MESSAGE_ORDINAL, direction: "asc" }] })
        expect(records.map((entry) => entry.ordinal)).toEqual([0, 1])
        expect(records[0].message.images).toEqual(richMessage.images)
        expect(records[1].message).toEqual(second)

        await reopened.replaceAll([record(second, 0)])
        const replaced = await reopened.query()
        expect(replaced.records).toEqual([record(second, 0)])
        await reopened.close()
    })

    it("rolls back both collections when a transaction fails", async () => {
        const store = await openStore("task-rollback")
        await store.insert([record(richMessage, 0)])
        await expect(
            store.transaction(async (transaction) => {
                await transaction.replaceAll([])
                throw new Error("abort")
            }),
        ).rejects.toThrow("abort")
        const { records } = await store.query()
        expect(records).toHaveLength(1)
        expect(records[0].message.files).toEqual(["/tmp/a.txt"])
        await store.close()
    })

    it("rejects query shapes the buffered store never uses", async () => {
        const store = await openStore("task-shapes")
        await expect(store.query({ orderBy: [{ field: UI_MESSAGE_ORDINAL, direction: "desc" }] })).rejects.toThrow(
            "ascending ordinal",
        )
        await expect(store.upsert()).rejects.toThrow("upsert")
        await store.close()
    })
})
