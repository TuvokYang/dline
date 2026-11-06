import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SettingsSnapshot } from "@core/storage/settings/settings-types"
import { parseSettingsDocument } from "@core/storage/settings/settings-validation"
import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler } from "@core/task/message-state"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import type { ExtensionState, UiMessage } from "@shared/ExtensionMessage"
import type { State } from "@shared/proto/dline/state"
import { FetchMessageRequest } from "@shared/proto/dline/task"
import { SETTINGS_DEFAULTS } from "@shared/storage/state-keys"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "../index"
import { cleanupStateSubscriptions, subscribeToState } from "../state/subscribeToState"
import { fetchMessage } from "../task/fetchMessage"
import { HistoryDisplaySession } from "../task/HistoryDisplaySession"

vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => "test-distinct-id" }))
vi.mock("@/utils/announcements", () => ({ getLatestAnnouncementId: () => "test-announcement" }))

const row = (ts: number, say: UiMessage["say"] = "text"): UiMessage => ({ ts, type: "say", say, text: `body-${ts}` })
const taskId = "current-source-index"

/** Real Controller projection/paging with only unrelated settings/runtime services isolated. */
function controllerFor(messages: MessageStateHandler): Controller {
    const controller = Object.create(Controller.prototype) as Controller
    const snapshot: SettingsSnapshot = {
        schemaVersion: 1,
        revision: 0,
        values: parseSettingsDocument(SETTINGS_DEFAULTS).values,
        contentHash: "fixture",
        awayRevocations: { mode: 0, automatic: 0 },
    }
    Object.assign(controller, {
        task: createSessionFixture({ taskId, taskInstanceId: "live-1", owners: { messages } }),
        nextStateRevision: 0,
        latestStateRevision: 0,
        stateBuildsAfterDetach: 0,
        stateManager: {
            setActiveTaskId: vi.fn(),
            getApiConfiguration: () => ({}),
            getGlobalStateKey: (key: string) => (key === "taskHistory" ? [] : undefined),
            getGlobalSettingsKey: () => undefined,
            getCanonicalSettingsKey: () => undefined,
            getWorkspaceStateKey: () => undefined,
            getRemoteConfigSettings: () => ({}),
            subscribeAwaySettings: () => () => undefined,
            readAwaySettingsSnapshot: () => snapshot,
            revokeAwayMode: async () => snapshot,
        },
        readLocalCapabilityToggles: () => ({}),
        ensureWorkspaceManager: async () => undefined,
        projectCurrentTaskViewState: () => undefined,
        modeSwitchCoordinator: { getSnapshot: () => ({}) },
        getTaskLockStatus: () => undefined,
    })
    return controller
}

function request(controller: Controller, fields: Partial<FetchMessageRequest> = {}): FetchMessageRequest {
    const opening = controller.currentOpening()!
    return FetchMessageRequest.create({
        taskId: opening.taskId,
        taskInstanceId: opening.taskInstanceId,
        referenceIndex: -1,
        count: 1,
        ...fields,
    })
}

describe("Controller message source-index delivery", () => {
    let documentsRoot: string
    let store: UIMessage
    let messages: MessageStateHandler
    let controller: Controller

    beforeEach(async () => {
        documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-current-index-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
        store = await UIMessage.open(taskId)
        await store.overwrite([row(100, "task"), row(300, "user_feedback"), row(200, "tool"), row(500, "user_feedback")])
        messages = new MessageStateHandler({ taskId, ulid: "current-index", updateTaskHistory: async () => [], uiMessage: store })
        messages.upsertTransientClineMessage(row(250, "checkpoint_created"))
        controller = controllerFor(messages)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        cleanupStateSubscriptions(controller)
        await store.close()
        vi.useRealTimers()
        vi.unstubAllEnvs()
        await fs.rm(documentsRoot, { recursive: true, force: true })
    })

    it("sends task0 through full state while projecting only the title, then gives the first RPC page the same mapping", async () => {
        const mapping = vi.spyOn(store, "sourceIndexOfTimestamp")
        const windowRead = vi.spyOn(controller, "getCurrentTaskMessages")
        const delivered: State[] = []
        await subscribeToState(controller, {}, async (state) => {
            delivered.push(state)
        })
        expect(delivered).toHaveLength(1)
        const state = JSON.parse(delivered[0].stateJson) as ExtensionState
        expect(state.taskTitleMessage).toMatchObject({ ts: 100, say: "task", text: "body-100", messageIndex: 0 })
        expect(state.totalMessageCount).toBe(5)
        expect(state.firstItemIndex).toBe(0)
        expect(windowRead).toHaveBeenCalledOnce()
        expect(mapping.mock.calls).toEqual([[100]])
        expect(state).not.toHaveProperty("clineMessages")
        const firstPage = await fetchMessage(controller, request(controller, { count: 5 }))
        expect(firstPage.startIndex).toBe(0)
        expect(firstPage.totalCount).toBe(5)
        expect(firstPage.messages.map((message) => [message.ts, message.messageIndex])).toEqual([
            [100, 0],
            [200, 2],
            [250, undefined],
            [300, 1],
            [500, 3],
        ])
        expect(store.getAll().every((message) => !("messageIndex" in message))).toBe(true)
    })

    it("preserves history title0 in full state while the latest body starts at canonical index60", async () => {
        const historyTaskId = "history-state-source-index"
        const writer = await UIMessage.open(historyTaskId)
        try {
            await writer.overwrite(Array.from({ length: 260 }, (_, index) => row(index + 1, index === 0 ? "task" : "text")))
        } finally {
            await writer.close()
        }
        const history = new HistoryDisplaySession({
            id: historyTaskId,
            ts: 1,
            task: "history",
            tokensIn: 0,
            tokensOut: 0,
            totalCost: 0,
        })
        try {
            await history.load()
            Object.assign(controller, { task: undefined, historyDisplaySession: history })
            const state = await controller.getStateToPostToWebview()
            expect(state.taskTitleMessage).toMatchObject({ ts: 1, messageIndex: 0 })
            expect(state.totalMessageCount).toBe(260)
            expect(state.firstItemIndex).toBe(60)
            const latest = await fetchMessage(controller, request(controller, { count: 2 }))
            expect(latest.startIndex).toBe(258)
            expect(latest.messages.map((message) => [message.ts, message.messageIndex])).toEqual([
                [259, 258],
                [260, 259],
            ])
        } finally {
            await history.dispose()
        }
    })

    it("locates count1 in the ts presentation sequence, not at its source ordinal, including index0", async () => {
        const page = await fetchMessage(controller, request(controller, { anchorIndex: 1, anchorTs: 300 }))
        expect(page).toMatchObject({ startIndex: 3, totalCount: 5, anchorFound: true, messages: [{ ts: 300, messageIndex: 1 }] })
        expect(page.messages).toHaveLength(1)
        await expect(fetchMessage(controller, request(controller, { anchorIndex: 0, anchorTs: 100 }))).resolves.toMatchObject({
            startIndex: 0,
            anchorFound: true,
            messages: [{ ts: 100, messageIndex: 0 }],
        })
        await expect(fetchMessage(controller, request(controller, { anchorIndex: 2 }))).resolves.toMatchObject({
            startIndex: 1,
            anchorFound: true,
            messages: [{ ts: 200, messageIndex: 2 }],
        })
        const wide = await fetchMessage(controller, request(controller, { anchorIndex: 3, anchorTs: 500, count: 20 }))
        expect(wide.startIndex).toBe(0)
        expect(wide.messages.map((message) => message.ts)).toEqual([100, 200, 250, 300, 500])
    })

    it("keeps ordinary reference/ts pages and transient/staged rows on their original coordinates", async () => {
        messages.upsertTransientClineMessage({
            ...row(275, "tool"),
            text: JSON.stringify({ tool: "summarizeTask", compactionStatus: "running" }),
            partial: true,
        })
        await store.upsertMessage(row(150))
        const page = await fetchMessage(controller, request(controller, { anchorIndex: 1, anchorTs: 300 }))
        expect(page).toMatchObject({ startIndex: 5, totalCount: 7, anchorFound: true, messages: [{ ts: 300, messageIndex: 1 }] })
        const reference = await fetchMessage(controller, request(controller, { referenceIndex: 1, count: 4 }))
        expect(reference.startIndex).toBe(1)
        expect(reference.messages.map((message) => [message.ts, message.messageIndex])).toEqual([
            [150, undefined],
            [200, 2],
            [250, undefined],
            [275, undefined],
        ])
        const timestamp = await fetchMessage(controller, request(controller, { anchorTs: 200 }))
        expect(timestamp).toMatchObject({ startIndex: 2, anchorFound: true, messages: [{ ts: 200, messageIndex: 2 }] })
        const transient = await fetchMessage(controller, request(controller, { anchorTs: 275 }))
        expect(transient.startIndex).toBe(4)
        expect(transient.messages[0].messageIndex).toBeUndefined()
        await expect(
            fetchMessage(controller, request(controller, { anchorIndex: 1, anchorTs: 300, count: 0 })),
        ).resolves.toMatchObject({
            messages: [],
            anchorFound: false,
        })
    })

    it("does not relocate a stale pair by ts, and the next correct request still succeeds", async () => {
        const mapping = vi.spyOn(store, "sourceIndexOfTimestamp")
        const read = vi.spyOn(store, "readCommittedMessageAt")
        const stale = await fetchMessage(controller, request(controller, { anchorIndex: 1, anchorTs: 200 }))
        expect(stale).toMatchObject({ messages: [], anchorFound: false })
        expect(read.mock.calls).toEqual([[1]])
        expect(mapping).not.toHaveBeenCalled()
        const next = await fetchMessage(controller, request(controller, { anchorIndex: 2, anchorTs: 200 }))
        expect(next).toMatchObject({ startIndex: 1, anchorFound: true, messages: [{ ts: 200, messageIndex: 2 }] })
        await expect(fetchMessage(controller, request(controller, { anchorIndex: 99, anchorTs: 300 }))).resolves.toMatchObject({
            messages: [],
            anchorFound: false,
        })
        expect(messages.clineMessages.map((message) => message.ts)).toEqual([100, 200, 250, 300, 500])
    })

    it("rejects an index that moves during page projection instead of returning a page for the wrong source row", async () => {
        const project = messages.readClineMessageProjection.bind(messages)
        vi.spyOn(messages, "readClineMessageProjection").mockImplementationOnce(async (page) => {
            const projected = await project(page)
            await store.insertAt(1, row(150))
            return projected
        })
        await expect(fetchMessage(controller, request(controller, { anchorIndex: 1, anchorTs: 300 }))).resolves.toMatchObject({
            messages: [],
            anchorFound: false,
        })
        await expect(fetchMessage(controller, request(controller, { anchorIndex: 2, anchorTs: 300 }))).resolves.toMatchObject({
            startIndex: 4,
            anchorFound: true,
            messages: [{ ts: 300, messageIndex: 2 }],
        })
    })

    it("lets the existing RPC boundary reject I/O failures rather than reporting a normal missing target", async () => {
        const failure = new Error("committed row read failed")
        vi.spyOn(messages, "readClineMessageAtSourceIndex").mockRejectedValueOnce(failure)
        await expect(fetchMessage(controller, request(controller, { anchorIndex: 1, anchorTs: 300 }))).rejects.toBe(failure)
        await expect(fetchMessage(controller, request(controller, { anchorIndex: 1, anchorTs: 300 }))).resolves.toMatchObject({
            anchorFound: true,
            messages: [{ ts: 300, messageIndex: 1 }],
        })
    })

    it("rebuilds full state for the new opening when the title metadata read crosses a same-task reopen", async () => {
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const reading = new Promise<void>((resolve) => {
            started = resolve
        })
        const project = store.projectMessageSourceIndexes.bind(store)
        vi.spyOn(store, "projectMessageSourceIndexes").mockImplementationOnce(async (rows) => {
            started()
            await gate
            return await project(rows)
        })
        const build = controller.getStateToPostToWebview()
        await reading
        messages.upsertTransientClineMessage({ ...row(100, "task"), text: "reopened title" })
        controller.task = createSessionFixture({ taskId, taskInstanceId: "live-2", owners: { messages } })
        release()
        const state = await build
        expect(state.taskTitleMessage).toMatchObject({ text: "reopened title", messageIndex: 0 })
        expect(controller.currentOpening()?.taskInstanceId).toBe("live-2")
    })
})
