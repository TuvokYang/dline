import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import { FetchMessageRequest } from "@shared/proto/dline/task"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "@/core/controller"
import { writeJsonl } from "@/core/storage/backend/jsonl/jsonl-utils"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { UiMessageRowStore } from "@/core/storage/messages/UiMessageRowStore"
import { UIMessage } from "@/core/storage/UIMessage"
import { anchoredPage, UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"
import { fetchMessage } from "../fetchMessage"
import { HistoryDisplaySession } from "../HistoryDisplaySession"

const OPENING = { taskId: "task-anchor", taskInstanceId: "open-1" }

const row = (ts: number, fields: Partial<UiMessage> = {}): UiMessage => ({
    ts,
    type: "say",
    say: "text",
    text: `row-${ts}`,
    ...fields,
})

describe("anchoredPage on the live sequence", () => {
    // Checkpoint and held compaction rows are transient: they sit in the live
    // sequence but may never reach messages.db, so the anchor must be located in
    // the very sequence the page is cut from.
    const live: UiMessage[] = [
        row(10, { say: "task", text: "first" }),
        row(20, { say: "checkpoint_created", text: "" }),
        row(30, { say: "tool", text: JSON.stringify({ tool: "summarizeTask", compactionStatus: "running" }) }),
        row(40),
        row(50, { say: "user_feedback", text: "second" }),
        row(60),
        row(70),
    ]

    it("serves exactly the anchor for a page of one", () => {
        expect(anchoredPage(live, 50, 1)).toEqual({ messages: [live[4]], totalCount: 7, startIndex: 4, anchorFound: true })
    })

    it("centres a wider page on the anchor and clamps it at the end of the sequence", () => {
        expect(anchoredPage(live, 40, 3)).toMatchObject({ startIndex: 2, messages: [live[2], live[3], live[4]] })
        expect(anchoredPage(live, 70, 4)).toMatchObject({ startIndex: 3, messages: live.slice(3) })
        expect(anchoredPage(live, 10, 4)).toMatchObject({ startIndex: 0, messages: live.slice(0, 4) })
    })

    it("reports an anchor removed before the fetch instead of serving another page", () => {
        const restored = live.filter((message) => message.ts !== 50)

        expect(anchoredPage(restored, 50, 5)).toEqual({ messages: [], totalCount: 6, startIndex: 0, anchorFound: false })
    })
})

describe("HistoryDisplaySession.fetchAnchoredPage", () => {
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-anchor-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await fs.rm(documentsRoot, { recursive: true, force: true })
    })

    it("pages the display's own durable sequence, beyond the window it loaded first", async () => {
        const taskId = "history-anchor"
        const store = await UIMessage.open(taskId)
        try {
            for (let index = 0; index < 260; index++) {
                await store.addMessage(row(index + 1, index === 0 ? { say: "task", text: "first" } : {}))
            }
            await store.flush()
        } finally {
            await store.close()
        }
        const session = new HistoryDisplaySession({ id: taskId, ts: 1, task: "first", tokensIn: 0, tokensOut: 0, totalCost: 0 })
        try {
            await session.load()
            // The first window holds only the latest rows; ts 21 is far before it.
            expect(session.getMessages().some((message) => message.ts === 21)).toBe(false)

            await expect(session.fetchAnchoredPage(21, 1)).resolves.toMatchObject({
                startIndex: 20,
                totalCount: 260,
                messages: [{ ts: 21 }],
                anchorFound: true,
            })
            const centred = await session.fetchAnchoredPage(21, 10)
            expect(centred.startIndex).toBe(15)
            expect(centred.messages.map((message) => message.ts)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25])

            await expect(session.fetchAnchoredPage(9_999, 10)).resolves.toMatchObject({ messages: [], anchorFound: false })
        } finally {
            await session.dispose()
        }
    })
})

describe("fetchMessage with an anchor", () => {
    function controllerServing(page: { messages: UiMessage[]; totalCount: number; startIndex: number; anchorFound: boolean }) {
        const fetchCurrentTaskMessages = vi.fn(async () => page)
        return { controller: { currentOpening: () => OPENING, fetchCurrentTaskMessages }, fetchCurrentTaskMessages }
    }

    it("forwards the anchor and reports whether the page holds it", async () => {
        const { controller, fetchCurrentTaskMessages } = controllerServing({
            messages: [row(50)],
            totalCount: 7,
            startIndex: 4,
            anchorFound: true,
        })

        const response = await fetchMessage(
            controller as never,
            FetchMessageRequest.create({ ...OPENING, referenceIndex: -1, count: 1, anchorTs: 50 }),
        )

        expect(fetchCurrentTaskMessages).toHaveBeenCalledWith(-1, 1, 50)
        expect(response).toMatchObject({ startIndex: 4, totalCount: 7, anchorFound: true, ...OPENING })
        expect(response.messages.map((message) => Number(message.ts))).toEqual([50])
    })

    it("pages by index when the request names no anchor", async () => {
        const { controller, fetchCurrentTaskMessages } = controllerServing({
            messages: [],
            totalCount: 0,
            startIndex: 0,
            anchorFound: false,
        })

        await fetchMessage(controller as never, FetchMessageRequest.create({ ...OPENING, referenceIndex: 3, count: 2 }))

        expect(fetchCurrentTaskMessages).toHaveBeenCalledWith(3, 2, undefined)
    })

    it("forwards optional index0 ahead of a simultaneous timestamp/reference request and preserves wire metadata", async () => {
        const { controller, fetchCurrentTaskMessages } = controllerServing({
            messages: [{ ...row(10, { say: "task" }), messageIndex: 0 }],
            totalCount: 7,
            startIndex: 0,
            anchorFound: true,
        })
        const response = await fetchMessage(
            controller as never,
            FetchMessageRequest.create({
                ...OPENING,
                referenceIndex: 5,
                count: 1,
                anchorTs: 10,
                anchorIndex: 0,
            }),
        )
        expect(fetchCurrentTaskMessages).toHaveBeenCalledWith(5, 1, 10, 0)
        expect(response.messages[0].messageIndex).toBe(0)
        expect(response.anchorFound).toBe(true)
    })
})

describe("HistoryDisplaySession source-index pages through fetchMessage", () => {
    let documentsRoot: string
    let session: HistoryDisplaySession
    let controller: Controller
    const taskId = "history-source-index"

    const request = (fields: Partial<FetchMessageRequest> = {}) =>
        FetchMessageRequest.create({
            taskId,
            taskInstanceId: session.taskInstanceId,
            referenceIndex: -1,
            count: 1,
            ...fields,
        })

    beforeEach(async () => {
        documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-history-source-index-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        const writer = await UIMessage.open(taskId)
        try {
            await writer.overwrite(
                Array.from({ length: 260 }, (_, index) =>
                    row(index === 20 ? 900 : index + 1, {
                        say: index === 0 ? "task" : "text",
                        text: `source-${index}`,
                    }),
                ),
            )
        } finally {
            await writer.close()
        }
        session = new HistoryDisplaySession({ id: taskId, ts: 1, task: "history", tokensIn: 0, tokensOut: 0, totalCost: 0 })
        await session.load()
        controller = Object.assign(Object.create(Controller.prototype), { historyDisplaySession: session }) as Controller
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await session.dispose()
        vi.unstubAllEnvs()
        await fs.rm(documentsRoot, { recursive: true, force: true })
    })

    it("reads an unloaded source target and count1 page using bounded ordinals, not ts or loaded-window offsets", async () => {
        expect(session.getMessages().some((message) => message.ts === 900)).toBe(false)
        expect(session.getMessages()[0].messageIndex).toBe(60)
        expect(session.getTaskTitleMessage()?.messageIndex).toBe(0)
        const ranges = vi.spyOn(UiMessageRowStore.prototype, "readRange")
        const timestamps = vi.spyOn(UiMessageRowStore.prototype, "findLastByTimestamp")
        const ordinals = vi.spyOn(UIMessageWindowReader.prototype, "ordinalOfTimestamp")
        const page = await fetchMessage(controller, request({ anchorIndex: 20, anchorTs: 900 }))
        expect(page).toMatchObject({
            startIndex: 20,
            totalCount: 260,
            anchorFound: true,
            messages: [{ ts: 900, messageIndex: 20 }],
        })
        expect(page.messages).toHaveLength(1)
        expect(ranges.mock.calls).toEqual([
            [20, 21],
            [20, 21],
            [20, 21],
        ])
        expect(timestamps).not.toHaveBeenCalled()
        expect(ordinals).not.toHaveBeenCalled()
        await expect(fetchMessage(controller, request({ anchorIndex: 0, anchorTs: 1 }))).resolves.toMatchObject({
            startIndex: 0,
            messages: [{ ts: 1, messageIndex: 0 }],
            anchorFound: true,
        })
        const reference = await fetchMessage(controller, request({ referenceIndex: 19, count: 3 }))
        expect(reference.startIndex).toBe(19)
        expect(reference.messages.map((message) => [message.ts, message.messageIndex])).toEqual([
            [20, 19],
            [900, 20],
            [22, 21],
        ])
    })

    it("returns false for a stale pair/absent target/empty page without changing the next index request", async () => {
        const ordinals = vi.spyOn(UIMessageWindowReader.prototype, "ordinalOfTimestamp")
        await expect(fetchMessage(controller, request({ anchorIndex: 20, anchorTs: 22 }))).resolves.toMatchObject({
            messages: [],
            anchorFound: false,
        })
        await expect(fetchMessage(controller, request({ anchorIndex: 999, anchorTs: 900 }))).resolves.toMatchObject({
            messages: [],
            anchorFound: false,
        })
        await expect(fetchMessage(controller, request({ anchorIndex: 20, anchorTs: 900, count: 0 }))).resolves.toMatchObject({
            messages: [],
            anchorFound: false,
        })
        expect(ordinals).not.toHaveBeenCalled()
        await expect(fetchMessage(controller, request({ anchorIndex: 21, anchorTs: 22 }))).resolves.toMatchObject({
            startIndex: 21,
            messages: [{ ts: 22, messageIndex: 21 }],
            anchorFound: true,
        })
        // The no-index ts entry is still the original independent API.
        await expect(fetchMessage(controller, request({ anchorTs: 900 }))).resolves.toMatchObject({
            startIndex: 20,
            messages: [{ ts: 900, messageIndex: 20 }],
            anchorFound: true,
        })
    })

    it.each([
        "before-page",
        "after-page",
    ])("detects deletion/position movement %s instead of relocating the old ts", async (when) => {
        const fetch = session.fetchMessages.bind(session)
        vi.spyOn(session, "fetchMessages").mockImplementationOnce(async (reference, count) => {
            const previous = when === "after-page" ? await fetch(reference, count) : undefined
            const writer = await UIMessage.open(taskId)
            try {
                await writer.deleteAt(0)
            } finally {
                await writer.close()
            }
            return previous ?? (await fetch(reference, count))
        })
        await expect(fetchMessage(controller, request({ anchorIndex: 20, anchorTs: 900 }))).resolves.toMatchObject({
            messages: [],
            anchorFound: false,
        })
        await expect(fetchMessage(controller, request({ anchorIndex: 19, anchorTs: 900 }))).resolves.toMatchObject({
            startIndex: 19,
            messages: [{ ts: 900, messageIndex: 19 }],
            anchorFound: true,
        })
    })

    it("does not grant a legacy page a canonical index or create/import its database", async () => {
        const legacyTaskId = "legacy-index-request"
        const directory = await ensureTaskDirectoryExists(legacyTaskId)
        const file = path.join(directory, GlobalFileNames.uiMessages)
        await writeJsonl(file, [row(10, { say: "task" }), row(20)])
        const before = await fs.readFile(file, "utf8")
        const legacy = new HistoryDisplaySession({
            id: legacyTaskId,
            ts: 10,
            task: "legacy",
            tokensIn: 0,
            tokensOut: 0,
            totalCost: 0,
        })
        try {
            await legacy.load()
            await expect(legacy.fetchSourceIndexedPage(0, 1, 10)).resolves.toMatchObject({ messages: [], anchorFound: false })
            await expect(legacy.fetchSourceIndexedPage(1, 1, 20)).resolves.toMatchObject({ messages: [], anchorFound: false })
            const timestamp = await legacy.fetchAnchoredPage(20, 1)
            expect(timestamp).toMatchObject({ startIndex: 1, messages: [{ ts: 20 }], anchorFound: true })
            expect(timestamp.messages[0]).not.toHaveProperty("messageIndex")
            expect(legacy.getTaskTitleMessage()).not.toHaveProperty("messageIndex")
        } finally {
            await legacy.dispose()
        }
        expect(await fs.readFile(file, "utf8")).toBe(before)
        expect((await fs.readdir(directory)).filter((name) => name.startsWith("messages"))).toEqual([])
    })

    it.each(["reopen", "promotion"])("rejects a late index page after same-task %s", async (kind) => {
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const reading = new Promise<void>((resolve) => {
            started = resolve
        })
        const fetch = session.fetchSourceIndexedPage.bind(session)
        vi.spyOn(session, "fetchSourceIndexedPage").mockImplementationOnce(async (...args) => {
            started()
            await gate
            return await fetch(...args)
        })
        const pending = fetchMessage(controller, request({ anchorIndex: 20, anchorTs: 900 }))
        await reading
        const replacement = { taskId, taskInstanceId: `${kind}-opening` }
        Object.assign(
            controller,
            kind === "promotion"
                ? { task: replacement, historyDisplaySession: undefined }
                : { historyDisplaySession: replacement },
        )
        release()
        await expect(pending).rejects.toThrow("Message query Task instance was closed")
    })

    it("propagates actual reader I/O failure and does not poison the next request", async () => {
        const failure = new Error("history row read failed")
        vi.spyOn(UIMessageWindowReader.prototype, "getBySourceIndex").mockRejectedValueOnce(failure)
        await expect(fetchMessage(controller, request({ anchorIndex: 20, anchorTs: 900 }))).rejects.toBe(failure)
        await expect(fetchMessage(controller, request({ anchorIndex: 0, anchorTs: 1 }))).resolves.toMatchObject({
            messages: [{ ts: 1, messageIndex: 0 }],
            anchorFound: true,
        })
    })
})
