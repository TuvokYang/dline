import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UIMessage } from "../UIMessage"

const row = (ts: number, say: UiMessage["say"] = "text"): UiMessage => ({ ts, type: "say", say, text: `body-${ts}` })

describe.each(["sqlite", "jsonl"])("UIMessage committed source indexes (%s)", (backend) => {
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-source-index-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        vi.stubEnv("DLINE_INSTANCE_STORAGE_BACKEND", backend)
        // Keep a staged row staged while checking read-only behavior.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.useRealTimers()
        vi.unstubAllEnvs()
        await fs.rm(documentsRoot, { recursive: true, force: true })
    })

    it("projects physical ordinals without mutating rows, bodies or the commit log", async () => {
        const store = await UIMessage.open("committed-projection")
        try {
            await store.overwrite([row(100, "task"), row(300, "user_feedback"), row(200, "tool"), row(500, "user_feedback")])
            const committed = await UIMessage.openCommittedUiMessages("committed-projection")
            try {
                const beforeHead = await committed.log.head()
                const beforeRows = await committed.rows.readRange(0, 4)
                const raw = store.getAll()
                const rawBody = JSON.stringify(raw)
                const outgoing = [raw[0], raw[2], { ...row(250), messageIndex: 999 }, raw[1], raw[3]]
                const projected = await store.projectMessageSourceIndexes(outgoing)

                expect(projected.map((message) => message.messageIndex)).toEqual([0, 2, undefined, 1, 3])
                expect(projected.map((message) => [message.ts, message.text])).toEqual([
                    [100, "body-100"],
                    [200, "body-200"],
                    [250, "body-250"],
                    [300, "body-300"],
                    [500, "body-500"],
                ])
                projected.forEach((message, index) => expect(message).not.toBe(outgoing[index]))
                expect(outgoing[2].messageIndex).toBe(999)
                expect(JSON.stringify(raw)).toBe(rawBody)
                expect(raw.every((message) => !("messageIndex" in message))).toBe(true)
                expect(await store.readCommittedMessageAt(0)).toMatchObject({ ordinal: 0, message: { ts: 100 } })
                expect(await store.readCommittedMessageAt(1)).toMatchObject({ ordinal: 1, message: { ts: 300 } })
                expect(await store.readCommittedMessageAt(4)).toBeUndefined()
                expect(await store.readCommittedMessageAt(-1)).toBeUndefined()
                expect(await store.readCommittedMessageAt(1.5)).toBeUndefined()
                expect(await committed.log.head()).toEqual(beforeHead)
                expect(await committed.rows.readRange(0, 4)).toEqual(beforeRows)
            } finally {
                await committed.close()
            }
        } finally {
            await store.close()
        }
        const reopened = await UIMessage.open("committed-projection")
        try {
            expect(reopened.getAll().map(({ ts, messageIndex }) => [ts, messageIndex])).toEqual([
                [100, undefined],
                [300, undefined],
                [200, undefined],
                [500, undefined],
            ])
        } finally {
            await reopened.close()
        }
    })

    it("does not mistake a staged insertion or a buffer offset for a committed position", async () => {
        const store = await UIMessage.open("staged-projection")
        try {
            await store.overwrite([row(100, "task"), row(300), row(500)])
            await store.upsertMessage(row(150))
            expect(store.getAll().map((message) => message.ts)).toEqual([100, 150, 300, 500])
            expect(store.findIndexByTs(300)).toBe(2)
            expect(await store.sourceIndexOfTimestamp(300)).toBe(1)
            expect(await store.sourceIndexOfTimestamp(150)).toBeUndefined()
            expect(await store.readCommittedMessageAt(1)).toMatchObject({ ordinal: 1, message: { ts: 300 } })
            expect((await store.projectMessageSourceIndexes(store.getAll())).map((message) => message.messageIndex)).toEqual([
                0,
                undefined,
                1,
                2,
            ])

            // Only the existing writer's explicit commit changes these positions.
            await store.flush()
            expect((await store.projectMessageSourceIndexes(store.getAll())).map((message) => message.messageIndex)).toEqual([
                0, 1, 2, 3,
            ])
            expect(await store.readCommittedMessageAt(1)).toMatchObject({ ordinal: 1, message: { ts: 150 } })
            expect(store.getAll().every((message) => !("messageIndex" in message))).toBe(true)
        } finally {
            await store.close()
        }
    })
})
