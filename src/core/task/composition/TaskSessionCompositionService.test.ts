import { afterEach, describe, expect, it, vi } from "vitest"
import type { TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import { type OpenTaskSessionCompositionOptions, TaskSessionCompositionService } from "./TaskSessionCompositionService"

const persistenceMock = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock("../shell/TaskPersistenceAssembly", () => ({
	openTaskPersistence: persistenceMock.open,
}))

function messageStores() {
	return {
		uiMessage: { close: vi.fn(async () => undefined) },
		apiConversation: { close: vi.fn(async () => undefined) },
	}
}

function openOptions(stores: ReturnType<typeof messageStores>): OpenTaskSessionCompositionOptions {
	return {
		taskId: "task-open-failure",
		openReason: "resume",
		messages: {
			uiMessage: stores.uiMessage,
			apiConversation: stores.apiConversation,
			updateTaskHistory: async () => [],
		},
	} as unknown as OpenTaskSessionCompositionOptions
}

describe("TaskSessionCompositionService", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		persistenceMock.open.mockReset()
	})

	// The chat store holds the single messages.db writer. Left open, it refuses
	// every write of the next incarnation opened in this window.
	it("closes the message stores it was handed when the task persistence cannot open", async () => {
		const stores = messageStores()
		const failure = new Error("journal.db is unreadable")
		persistenceMock.open.mockRejectedValue(failure)

		await expect(new TaskSessionCompositionService().open(openOptions(stores))).rejects.toBe(failure)

		expect(stores.uiMessage.close).toHaveBeenCalledOnce()
		expect(stores.apiConversation.close).toHaveBeenCalledOnce()
	})

	it("closes the persistence and the message stores when composition fails, keeping the original error", async () => {
		const stores = messageStores()
		const persistence = { close: vi.fn(async () => undefined) } as unknown as TaskPersistenceAssembly
		persistenceMock.open.mockResolvedValue(persistence)
		const failure = new Error("composition failed")
		vi.spyOn(
			TaskSessionCompositionService.prototype as unknown as { compose: () => Promise<never> },
			"compose",
		).mockRejectedValue(failure)
		stores.uiMessage.close.mockRejectedValue(new Error("close failed"))

		await expect(new TaskSessionCompositionService().open(openOptions(stores))).rejects.toBe(failure)

		expect(persistence.close).toHaveBeenCalledOnce()
		expect(stores.uiMessage.close).toHaveBeenCalledOnce()
		expect(stores.apiConversation.close).toHaveBeenCalledOnce()
	})
})
