import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiConversation } from "../ApiConversation"
import { openTaskMessages } from "../TaskMessages"
import { UIMessage } from "../UIMessage"

vi.mock("../ApiConversation", () => ({ ApiConversation: { open: vi.fn() } }))
vi.mock("../UIMessage", () => ({ UIMessage: { open: vi.fn() } }))

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}

function stores() {
    return {
        uiMessage: { close: vi.fn(async () => undefined) } as unknown as UIMessage,
        apiConversation: { close: vi.fn(async () => undefined) } as unknown as ApiConversation,
    }
}

beforeEach(() => vi.resetAllMocks())

describe("task message acquisition", () => {
    it("starts the independent API store while the UI store is still opening", async () => {
        const held = deferred<UIMessage>()
        const pair = stores()
        let apiStarted = false
        vi.mocked(UIMessage.open).mockReturnValue(held.promise)
        vi.mocked(ApiConversation.open).mockImplementation(async () => {
            apiStarted = true
            return pair.apiConversation
        })
        const opening = openTaskMessages("task-a")
        try {
            await Promise.resolve()
            expect(apiStarted).toBe(true)
        } finally {
            held.resolve(pair.uiMessage)
            await expect(opening).resolves.toEqual(pair)
        }
        expect(pair.uiMessage.close).not.toHaveBeenCalled()
        expect(pair.apiConversation.close).not.toHaveBeenCalled()
    })

    it.each(["ui", "api"] as const)("releases the other store when %s acquisition fails late", async (failed) => {
        const held = deferred<never>()
        const pair = stores()
        const error = new Error(`${failed} open failed`)
        vi.mocked(UIMessage.open).mockImplementation(() => (failed === "ui" ? held.promise : Promise.resolve(pair.uiMessage)))
        vi.mocked(ApiConversation.open).mockImplementation(() =>
            failed === "api" ? held.promise : Promise.resolve(pair.apiConversation),
        )
        const opening = openTaskMessages("task-a")
        const outcome = opening.catch((failure: unknown) => failure)
        await Promise.resolve()
        held.reject(error)
        expect(await outcome).toBe(error)
        const acquired = failed === "ui" ? pair.apiConversation : pair.uiMessage
        expect(acquired.close).toHaveBeenCalledOnce()
    })

    it("waits for a late successful acquisition and its cleanup before rejecting", async () => {
        const late = deferred<ApiConversation>()
        const closing = deferred<void>()
        const pair = stores()
        const error = new Error("UI unavailable")
        vi.mocked(UIMessage.open).mockRejectedValue(error)
        vi.mocked(ApiConversation.open).mockReturnValue(late.promise)
        vi.mocked(pair.apiConversation.close).mockReturnValue(closing.promise)
        let settled = false
        const outcome = openTaskMessages("task-a").then(
            () => undefined,
            (failure: unknown) => {
                settled = true
                return failure
            },
        )
        await Promise.resolve()
        await Promise.resolve()
        expect(settled).toBe(false)
        late.resolve(pair.apiConversation)
        await vi.waitFor(() => expect(pair.apiConversation.close).toHaveBeenCalledOnce())
        expect(settled).toBe(false)
        closing.resolve()
        expect(await outcome).toBe(error)
    })

    it("retains both acquisition errors", async () => {
        const uiError = new Error("UI unavailable")
        const apiError = new Error("API unavailable")
        vi.mocked(UIMessage.open).mockRejectedValue(uiError)
        vi.mocked(ApiConversation.open).mockRejectedValue(apiError)
        const failure = await openTaskMessages("task-a").catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([uiError, apiError])
    })

    it("retains cleanup failure beside the original acquisition failure", async () => {
        const pair = stores()
        const openError = new Error("API unavailable")
        const closeError = new Error("UI close unavailable")
        vi.mocked(UIMessage.open).mockResolvedValue(pair.uiMessage)
        vi.mocked(ApiConversation.open).mockRejectedValue(openError)
        vi.mocked(pair.uiMessage.close).mockRejectedValue(closeError)
        const failure = await openTaskMessages("task-a").catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([openError, closeError])
    })
})
