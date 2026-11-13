import { beforeEach, describe, expect, it, vi } from "vitest"
import { openTaskMessages } from "../../storage/TaskMessages"
import { openTaskPersistence } from "../shell/TaskPersistenceAssembly"
import { openTaskStores } from "./TaskOpeningStores"

vi.mock("../../storage/TaskMessages", () => ({ openTaskMessages: vi.fn() }))
vi.mock("../shell/TaskPersistenceAssembly", () => ({ openTaskPersistence: vi.fn() }))

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}

function stores(missing?: "messages" | "persistence") {
    const live = new Set([...(missing === "messages" ? [] : ["ui", "api"]), ...(missing === "persistence" ? [] : ["journal"])])
    const close = (name: string) =>
        vi.fn(async () => {
            live.delete(name)
        })
    return {
        live,
        messages: {
            uiMessage: { close: close("ui") },
            apiConversation: { close: close("api") },
        } as unknown as Awaited<ReturnType<typeof openTaskMessages>>,
        persistence: { close: close("journal") } as unknown as Awaited<ReturnType<typeof openTaskPersistence>>,
    }
}

beforeEach(() => vi.resetAllMocks())

describe("task opening stores", () => {
    it("opens the independent journal while messages are still opening", async () => {
        const pair = stores()
        const held = deferred<typeof pair.messages>()
        let journalStarted = false
        vi.mocked(openTaskMessages).mockReturnValue(held.promise)
        vi.mocked(openTaskPersistence).mockImplementation(async () => {
            journalStarted = true
            return pair.persistence
        })
        const opening = openTaskStores("task-a")
        try {
            await Promise.resolve()
            expect(journalStarted).toBe(true)
        } finally {
            held.resolve(pair.messages)
            await expect(opening).resolves.toEqual({ ...pair.messages, persistence: pair.persistence })
        }
        expect(pair.persistence.close).not.toHaveBeenCalled()
        expect(pair.messages.uiMessage.close).not.toHaveBeenCalled()
        expect(pair.messages.apiConversation.close).not.toHaveBeenCalled()
        expect(pair.live).toEqual(new Set(["ui", "api", "journal"]))
    })

    it.each(["messages", "persistence"] as const)("releases the acquired group when %s fails", async (failed) => {
        const pair = stores(failed)
        const error = new Error(`${failed} unavailable`)
        vi.mocked(openTaskMessages).mockImplementation(async () => {
            if (failed === "messages") throw error
            return pair.messages
        })
        vi.mocked(openTaskPersistence).mockImplementation(async () => {
            if (failed === "persistence") throw error
            return pair.persistence
        })
        await expect(openTaskStores("task-a")).rejects.toBe(error)
        expect(pair.live.size).toBe(0)
    })

    it("waits for a late journal acquisition and cleanup before rejecting", async () => {
        const pair = stores("messages")
        const late = deferred<typeof pair.persistence>()
        const closing = deferred<void>()
        const error = new Error("messages unavailable")
        vi.mocked(openTaskMessages).mockRejectedValue(error)
        vi.mocked(openTaskPersistence).mockReturnValue(late.promise)
        vi.mocked(pair.persistence.close!).mockImplementation(async () => {
            await closing.promise
            pair.live.delete("journal")
        })
        let settled = false
        const outcome = openTaskStores("task-a").catch((failure: unknown) => {
            settled = true
            return failure
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(settled).toBe(false)
        late.resolve(pair.persistence)
        await vi.waitFor(() => expect(pair.persistence.close).toHaveBeenCalledOnce())
        expect(settled).toBe(false)
        closing.resolve()
        expect(await outcome).toBe(error)
        expect(pair.live.size).toBe(0)
    })

    it("releases both late message stores after the journal fails", async () => {
        const pair = stores("persistence")
        const late = deferred<typeof pair.messages>()
        const error = new Error("journal unavailable")
        vi.mocked(openTaskMessages).mockReturnValue(late.promise)
        vi.mocked(openTaskPersistence).mockRejectedValue(error)
        let settled = false
        const outcome = openTaskStores("task-a").catch((failure: unknown) => {
            settled = true
            return failure
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(settled).toBe(false)
        late.resolve(pair.messages)
        expect(await outcome).toBe(error)
        expect(pair.live.size).toBe(0)
    })

    it("retains both acquisition errors", async () => {
        const messagesError = new Error("messages unavailable")
        const journalError = new Error("journal unavailable")
        vi.mocked(openTaskMessages).mockRejectedValue(messagesError)
        vi.mocked(openTaskPersistence).mockRejectedValue(journalError)
        const failure = await openTaskStores("task-a").catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([messagesError, journalError])
    })

    it("retains cleanup errors without skipping the other message store", async () => {
        const pair = stores("persistence")
        const openError = new Error("journal unavailable")
        const closeError = new Error("UI close unavailable")
        vi.mocked(openTaskMessages).mockResolvedValue(pair.messages)
        vi.mocked(openTaskPersistence).mockRejectedValue(openError)
        vi.mocked(pair.messages.uiMessage.close).mockRejectedValue(closeError)
        const failure = await openTaskStores("task-a").catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([openError, closeError])
        expect(pair.live).toEqual(new Set(["ui"]))
    })
})
