import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler } from "@core/task/message-state"
import type { UiMessage } from "@shared/ExtensionMessage"
import { ClineMessage } from "@shared/proto/dline/ui"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "../../index"
import { HistoryDisplaySession } from "../../task/HistoryDisplaySession"
import { registerPartialMessageCallback, sendPartialMessageEvent, subscribeToPartialMessage } from "../subscribeToPartialMessage"

const row = (ts: number, say: UiMessage["say"] = "text"): UiMessage => ({ ts, type: "say", say, text: `body-${ts}` })
const taskId = "partial-index"

function liveController(messages: MessageStateHandler, taskInstanceId = "live-1"): Controller {
    return Object.assign(Object.create(Controller.prototype), {
        task: { taskId, taskInstanceId, owners: { messages } },
    }) as Controller
}

describe("partial message committed source-index metadata", () => {
    let documentsRoot: string
    let store: UIMessage
    let messages: MessageStateHandler

    beforeEach(async () => {
        documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-partial-index-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        store = await UIMessage.open(taskId)
        await store.overwrite([row(100, "task"), row(300, "user_feedback"), row(200, "tool")])
        messages = new MessageStateHandler({ taskId, ulid: "partial-index", updateTaskHistory: async () => [], uiMessage: store })
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await store.close()
        vi.unstubAllEnvs()
        await fs.rm(documentsRoot, { recursive: true, force: true })
    })

    it("delivers owner metadata to streams and callbacks without mutating the host's Proto row", async () => {
        const controller = liveController(messages)
        const owner = controller.currentOpening()!
        const received: ClineMessage[] = []
        const callbacks: ClineMessage[] = []
        const unsubscribe = registerPartialMessageCallback((message) => callbacks.push(message))
        await subscribeToPartialMessage(controller, {}, async (message) => {
            received.push(message)
        })
        const transient = row(250, "checkpoint_created")
        messages.upsertTransientClineMessage(transient)
        const partial = { ...convertClineMessageToProto(row(200, "tool")), messageIndex: 999 }
        try {
            await sendPartialMessageEvent(controller, convertClineMessageToProto(row(100, "task")), owner)
            await sendPartialMessageEvent(controller, partial, owner)
            await sendPartialMessageEvent(controller, convertClineMessageToProto(transient), owner)
            expect(received.map((message) => [message.ts, message.messageIndex])).toEqual([
                [100, 0],
                [200, 2],
                [250, undefined],
            ])
            expect(callbacks.map((message) => [message.ts, message.messageIndex])).toEqual([
                [100, 0],
                [200, 2],
                [250, undefined],
            ])
            expect(received.map(({ taskId, taskInstanceId }) => [taskId, taskInstanceId])).toEqual([
                ["partial-index", "live-1"],
                ["partial-index", "live-1"],
                ["partial-index", "live-1"],
            ])
            expect(received[1]).not.toBe(partial)
            expect(received[1].text).toBe("body-200")
            expect(partial.messageIndex).toBe(999)
            expect(store.getAll().every((message) => !("messageIndex" in message))).toBe(true)
            expect(transient).not.toHaveProperty("messageIndex")
        } finally {
            unsubscribe()
        }
    })

    it("drops a late metadata read across a same-task reopen, then serves the next opening independently", async () => {
        const controller = liveController(messages)
        const owner = controller.currentOpening()!
        const received: ClineMessage[] = []
        await subscribeToPartialMessage(controller, {}, async (message) => {
            received.push(message)
        })
        const callback = vi.fn()
        const unsubscribe = registerPartialMessageCallback(callback)
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const reading = new Promise<void>((resolve) => {
            started = resolve
        })
        const project = messages.projectMessageSourceIndex.bind(messages)
        vi.spyOn(messages, "projectMessageSourceIndex").mockImplementationOnce(async (ts) => {
            started()
            await gate
            return await project(ts)
        })
        try {
            const late = sendPartialMessageEvent(controller, convertClineMessageToProto(row(300)), owner)
            await reading
            controller.task = liveController(messages, "live-2").task
            release()
            await late
            expect(received).toEqual([])
            expect(callback).not.toHaveBeenCalled()
            await sendPartialMessageEvent(controller, convertClineMessageToProto(row(200)), controller.currentOpening()!)
            expect(received).toMatchObject([{ ts: 200, messageIndex: 2, taskInstanceId: "live-2" }])
            expect(callback).toHaveBeenCalledOnce()
        } finally {
            release()
            unsubscribe()
        }
    })

    it("maps a historical maintained row outside the loaded window and fences promotion during that read", async () => {
        const historyTaskId = "history-partial-index"
        const historyStore = await UIMessage.open(historyTaskId)
        await historyStore.overwrite(Array.from({ length: 260 }, (_, index) => row(index + 1, index === 0 ? "task" : "text")))
        await historyStore.close()
        const history = new HistoryDisplaySession({
            id: historyTaskId,
            ts: 1,
            task: "history",
            tokensIn: 0,
            tokensOut: 0,
            totalCost: 0,
        })
        const controller = Object.assign(Object.create(Controller.prototype), { historyDisplaySession: history }) as Controller
        const received: ClineMessage[] = []
        await subscribeToPartialMessage(controller, {}, async (message) => {
            received.push(message)
        })
        try {
            await history.load()
            expect(history.getMessages().some((message) => message.ts === 21)).toBe(false)
            await sendPartialMessageEvent(controller, convertClineMessageToProto(row(21)), history)
            expect(received).toMatchObject([{ ts: 21, messageIndex: 20, taskInstanceId: history.taskInstanceId }])
            let release!: () => void
            let started!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const reading = new Promise<void>((resolve) => {
                started = resolve
            })
            const project = history.projectMessageSourceIndex.bind(history)
            vi.spyOn(history, "projectMessageSourceIndex").mockImplementationOnce(async (ts) => {
                started()
                await gate
                return await project(ts)
            })
            const late = sendPartialMessageEvent(controller, convertClineMessageToProto(row(22)), history)
            await reading
            Object.assign(controller, {
                historyDisplaySession: undefined,
                task: { taskId: historyTaskId, taskInstanceId: "promoted", owners: { messages } },
            })
            release()
            await late
            expect(received).toHaveLength(1)
        } finally {
            await history.dispose()
        }
    })

    it("preserves composing publication without opening another owner or inheriting a source index", async () => {
        const controller = Object.create(Controller.prototype) as Controller
        const received: ClineMessage[] = []
        await subscribeToPartialMessage(controller, {}, async (message) => {
            received.push(message)
        })
        const partial = { ...convertClineMessageToProto(row(100, "task")), messageIndex: 6 }
        await sendPartialMessageEvent(controller, partial, { taskId, taskInstanceId: "composing" })
        expect(received).toMatchObject([{ ts: 100, taskInstanceId: "composing" }])
        expect(received[0]).not.toHaveProperty("messageIndex")
        expect(partial.messageIndex).toBe(6)
    })

    it("propagates owner I/O failure without invoking subscribers or disabling the next publication", async () => {
        const controller = liveController(messages)
        const stream = vi.fn(async () => undefined)
        await subscribeToPartialMessage(controller, {}, stream)
        const failure = new Error("metadata read failed")
        vi.spyOn(messages, "projectMessageSourceIndex").mockRejectedValueOnce(failure)
        await expect(
            sendPartialMessageEvent(controller, convertClineMessageToProto(row(100)), controller.currentOpening()!),
        ).rejects.toBe(failure)
        expect(stream).not.toHaveBeenCalled()
        await sendPartialMessageEvent(controller, convertClineMessageToProto(row(100)), controller.currentOpening()!)
        expect(stream).toHaveBeenCalledOnce()
    })
})
