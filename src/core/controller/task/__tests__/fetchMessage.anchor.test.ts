import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import { FetchMessageRequest } from "@shared/proto/dline/task"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UIMessage } from "@/core/storage/UIMessage"
import { anchoredPage } from "@/core/storage/UIMessageWindowReader"
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
})
