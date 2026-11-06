import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UIMessage } from "../../storage/UIMessage"
import { MessageStateHandler } from "../message-state"

const row = (ts: number, say: UiMessage["say"] = "text"): UiMessage => ({ ts, type: "say", say, text: `body-${ts}` })

function messageState(uiMessage?: UIMessage): MessageStateHandler {
    return new MessageStateHandler({ taskId: "projection", ulid: "projection", updateTaskHistory: async () => [], uiMessage })
}

describe("MessageState source-index projection", () => {
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-state-index-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    })

    afterEach(async () => {
        vi.useRealTimers()
        vi.unstubAllEnvs()
        await fs.rm(documentsRoot, { recursive: true, force: true })
    })

    it("keeps ts presentation order while projecting committed source positions across transient overlays", async () => {
        const store = await UIMessage.open("projection")
        try {
            await store.overwrite([row(100, "task"), row(300, "user_feedback"), row(200, "tool"), row(500, "user_feedback")])
            const state = messageState(store)
            const transient = row(250, "checkpoint_created")
            state.upsertTransientClineMessage(transient)
            const before = state.clineMessages
            const revision = state.messageMutationRevision
            const changed = vi.fn()
            state.on("clineMessagesChanged", changed)
            const projected = await state.readClineMessageProjection()

            expect(projected.map((message) => [message.ts, message.messageIndex])).toEqual([
                [100, 0],
                [200, 2],
                [250, undefined],
                [300, 1],
                [500, 3],
            ])
            expect(state.durableClineMessages.map((message) => message.ts)).toEqual([100, 300, 200, 500])
            expect(state.clineMessages).toEqual(before)
            expect(state.clineMessages.every((message) => !("messageIndex" in message))).toBe(true)
            expect(transient).not.toHaveProperty("messageIndex")
            expect(state.messageMutationRevision).toBe(revision)
            expect(changed).not.toHaveBeenCalled()
            await expect(state.readClineMessageAtSourceIndex(1)).resolves.toMatchObject({ ts: 300 })

            const overlay = { ...row(300, "user_feedback"), text: "shown overlay", partial: true }
            state.upsertTransientClineMessage(overlay)
            const selected = await state.readClineMessageProjection([overlay, transient])
            expect(selected.map((message) => [message.text, message.messageIndex])).toEqual([
                ["shown overlay", 1],
                ["body-250", undefined],
            ])
            expect(selected[0]).not.toBe(overlay)
            expect(store.getByTs(300)?.text).toBe("body-300")
            await expect(state.projectMessageSourceIndex(300)).resolves.toBe(1)
            await expect(state.projectMessageSourceIndex(250)).resolves.toBeUndefined()
        } finally {
            await store.close()
        }
    })

    it("leaves a staged insertion unindexed without moving committed metadata until the writer flushes", async () => {
        const store = await UIMessage.open("projection")
        try {
            await store.overwrite([row(100, "task"), row(300), row(500)])
            const state = messageState(store)
            await store.upsertMessage(row(150))
            state.upsertTransientClineMessage(row(250, "tool"))
            expect((await state.readClineMessageProjection()).map((message) => [message.ts, message.messageIndex])).toEqual([
                [100, 0],
                [150, undefined],
                [250, undefined],
                [300, 1],
                [500, 2],
            ])
            await store.flush()
            expect((await state.readClineMessageProjection()).map((message) => [message.ts, message.messageIndex])).toEqual([
                [100, 0],
                [150, 1],
                [250, undefined],
                [300, 2],
                [500, 3],
            ])
        } finally {
            await store.close()
        }
    })

    it("never manufactures a persistent index in memory-only mode or inherits stale metadata", async () => {
        const state = messageState()
        const raw = { ...row(100, "task"), messageIndex: 7 }
        const projected = await state.readClineMessageProjection([raw])
        expect(projected).toEqual([row(100, "task")])
        expect(projected[0]).not.toBe(raw)
        expect(raw.messageIndex).toBe(7)
        await expect(state.projectMessageSourceIndex(100)).resolves.toBeUndefined()
        await expect(state.readClineMessageAtSourceIndex(0)).resolves.toBeUndefined()
    })
})
