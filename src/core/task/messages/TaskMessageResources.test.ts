import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { type TaskMessageResourcePorts, TaskMessageResources } from "./TaskMessageResources"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture() {
	const messages: ClineMessage[] = Array.from({ length: 512 }, (_, index) => ({
		ts: index + 1,
		type: "say",
		say: index === 0 ? "task" : "text",
		text: `message-${index}`,
	}))
	const page = (reference: number, count: number) => {
		const startIndex = reference === -1 ? Math.max(0, messages.length - count) : reference
		return { messages: messages.slice(startIndex, startIndex + count), totalCount: messages.length, startIndex }
	}
	const window = {
		count: messages.length,
		getLatest: vi.fn(async (count: number) => page(-1, count).messages),
		getPage: vi.fn(async (reference: number, count: number) => page(reference, count)),
		getByTimestamp: vi.fn(async (ts: number) => messages.find((message) => message.ts === ts)),
		close: vi.fn(async () => undefined),
	}
	const uiMessage = {
		get count() {
			return messages.length
		},
		getAll: () => messages,
		getAt: (index: number) => messages[index],
		getByTs: (ts: number) => messages.find((message) => message.ts === ts),
		close: vi.fn(async () => undefined),
	}
	const apiConversation = { close: vi.fn(async () => undefined) }
	const ports = {
		openWindow: vi.fn(async () => window),
		openUiMessages: vi.fn(async () => uiMessage),
		openApiConversation: vi.fn(async () => apiConversation),
		persistHistoricalMessage: vi.fn(async (_taskId: string, message: ClineMessage) => {
			const index = messages.findIndex((row) => row.ts === message.ts)
			if (index < 0) messages.push(message)
			else messages[index] = message
			return message
		}),
	}
	const resources = new TaskMessageResources("task-1", undefined, ports as unknown as TaskMessageResourcePorts)
	return { resources, messages, window, uiMessage, apiConversation, ports }
}

describe("TaskMessageResources", () => {
	it("displays an absolute window and durable title without opening execution histories", async () => {
		const { resources, messages, ports, window } = fixture()
		await resources.openDisplay()
		expect(resources.hasExecutionStores).toBe(false)
		expect(resources.getMessageCount()).toBe(512)
		expect(resources.getTitleMessage()).toEqual(messages[0])
		expect(resources.getDisplayMessages()).toEqual(messages.slice(-200))
		expect(await resources.fetchMessages(10, 3)).toEqual({
			messages: messages.slice(10, 13),
			totalCount: 512,
			startIndex: 10,
		})
		expect(await resources.getMessageByTimestamp(4)).toEqual(messages[3])
		expect(ports.openUiMessages).not.toHaveBeenCalled()
		expect(ports.openApiConversation).not.toHaveBeenCalled()
		await resources.close()
		expect(window.close).toHaveBeenCalledOnce()
	})

	it("reuses the initial tail for covered pages while preserving durable overlays", async () => {
		const { resources, messages, window } = fixture()
		await resources.openDisplay()
		window.getPage.mockClear()
		expect(await resources.fetchMessages(-1, 200)).toEqual({
			messages: messages.slice(-200),
			totalCount: 512,
			startIndex: 312,
		})
		expect((await resources.fetchMessages(320, 4)).messages).toEqual(messages.slice(320, 324))
		const replacement = { ...messages[510], text: "updated" }
		const appended: ClineMessage = { ts: 513, type: "ask", ask: "resume_task", text: "ready" }
		await resources.persistMessage(replacement)
		await resources.persistMessage(appended)
		expect(await resources.fetchMessages(-1, 3)).toEqual({
			messages: [replacement, messages[511], appended],
			totalCount: 513,
			startIndex: 510,
		})
		expect(window.getPage).not.toHaveBeenCalled()
		expect((await resources.fetchMessages(310, 4)).messages).toEqual(messages.slice(310, 314))
		expect(window.getPage).toHaveBeenCalledWith(310, 4)
		await resources.close()
	})

	it("does not treat an incomplete initial tail as a contiguous cached page", async () => {
		const { resources, messages, window } = fixture()
		window.getLatest.mockResolvedValueOnce(messages.slice(-199))
		await resources.openDisplay()
		window.getPage.mockClear()
		expect((await resources.fetchMessages(-1, 200)).messages).toEqual(messages.slice(-200))
		expect(window.getPage).toHaveBeenCalledWith(312, 200)
		await resources.close()
	})

	it("admits execution once on the same resource boundary and retains absolute paging", async () => {
		const { resources, messages, ports, window, uiMessage, apiConversation } = fixture()
		await resources.openDisplay()
		const [first, second] = await Promise.all([resources.openExecution(), resources.openExecution()])
		expect(first).toBe(second)
		expect(resources.hasExecutionStores).toBe(true)
		expect(resources.getDisplayMessages()).toEqual(messages)
		expect(await resources.fetchMessages(-1, 2)).toEqual({ messages: messages.slice(-2), totalCount: 512, startIndex: 510 })
		expect(ports.openUiMessages).toHaveBeenCalledOnce()
		expect(ports.openApiConversation).toHaveBeenCalledOnce()
		expect(window.close).toHaveBeenCalledOnce()
		await Promise.all([resources.close(), resources.close()])
		expect(uiMessage.close).toHaveBeenCalledOnce()
		expect(apiConversation.close).toHaveBeenCalledOnce()
		await expect(resources.fetchMessages(-1, 2)).rejects.toThrow("closed")
	})

	it("persists canonical asks in order without creating an execution history cache", async () => {
		const { resources, ports } = fixture()
		await resources.openDisplay()
		const ask: ClineMessage = { ts: 513, type: "ask", ask: "resume_task", interactionId: "resume:task-1:9", partial: false }
		await Promise.all([resources.persistMessage(ask), resources.persistMessage({ ...ask, text: "ready" })])
		expect(resources.getMessageCount()).toBe(513)
		expect((await resources.fetchMessages(-1, 1)).messages).toEqual([{ ...ask, text: "ready" }])
		expect(resources.hasExecutionStores).toBe(false)
		expect(ports.openUiMessages).not.toHaveBeenCalled()
		expect(ports.openApiConversation).not.toHaveBeenCalled()
		expect(ports.persistHistoricalMessage.mock.calls.map(([, message]) => message.text)).toEqual([undefined, "ready"])
		await resources.openExecution()
		expect(resources.getMessageCount()).toBe(513)
		expect(resources.getDisplayMessages().at(-1)).toEqual({ ...ask, text: "ready" })
		await resources.close()
	})

	it("closes a late-opened display reader instead of attaching it after Close", async () => {
		const { resources, window, ports } = fixture()
		const opening = deferred<typeof window>()
		ports.openWindow.mockReturnValueOnce(opening.promise)
		const displaying = resources.openDisplay()
		const failure = expect(displaying).rejects.toThrow("closed")
		const closing = resources.close()
		opening.resolve(window)
		await Promise.all([failure, closing])
		expect(resources.getDisplayMessages()).toEqual([])
		expect(resources.getMessageCount()).toBe(0)
		expect(window.close).toHaveBeenCalledOnce()
	})

	it("drains an admitted page read before closing its reader", async () => {
		const { resources, messages, window } = fixture()
		await resources.openDisplay()
		const reading = deferred<{ messages: ClineMessage[]; totalCount: number; startIndex: number }>()
		window.getPage.mockReturnValueOnce(reading.promise)
		const page = resources.fetchMessages(2, 2)
		await Promise.resolve()
		const closing = resources.close()
		expect(window.close).not.toHaveBeenCalled()
		reading.resolve({ messages: messages.slice(2, 4), totalCount: 512, startIndex: 2 })
		expect((await page).messages).toEqual(messages.slice(2, 4))
		await closing
		expect(window.close).toHaveBeenCalledOnce()
	})

	it("rolls back a failed execution admission and allows an explicit retry", async () => {
		const { resources, messages, ports, uiMessage, apiConversation, window } = fixture()
		await resources.openDisplay()
		ports.openApiConversation.mockRejectedValueOnce(new Error("API history unavailable"))
		await expect(resources.openExecution()).rejects.toThrow("API history unavailable")
		expect(resources.hasExecutionStores).toBe(false)
		expect(uiMessage.close).toHaveBeenCalledOnce()
		expect(resources.getDisplayMessages()).toEqual(messages.slice(-200))
		const replacementUi = { ...uiMessage, close: vi.fn(async () => undefined) }
		ports.openUiMessages.mockResolvedValueOnce(replacementUi)
		const retried = await resources.openExecution()
		expect(retried.uiMessage).toBe(replacementUi)
		expect(window.close).toHaveBeenCalledOnce()
		await resources.close()
		expect(replacementUi.close).toHaveBeenCalledOnce()
		expect(apiConversation.close).toHaveBeenCalledOnce()
	})

	it("releases partially opened execution stores when Close wins admission", async () => {
		const { resources, ports, uiMessage, apiConversation } = fixture()
		const apiOpening = deferred<typeof apiConversation>()
		ports.openApiConversation.mockReturnValueOnce(apiOpening.promise)
		const admission = resources.openExecution()
		const failure = expect(admission).rejects.toThrow("closed")
		await vi.waitFor(() => expect(ports.openApiConversation).toHaveBeenCalledOnce())
		const closing = resources.close()
		apiOpening.resolve(apiConversation)
		await Promise.all([failure, closing])
		expect(resources.hasExecutionStores).toBe(false)
		expect(uiMessage.close).toHaveBeenCalledOnce()
		expect(apiConversation.close).toHaveBeenCalledOnce()
	})
})
