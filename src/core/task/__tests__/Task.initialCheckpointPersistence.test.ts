import { Task } from "@core/task"
import { describe, expect, it, vi } from "vitest"

type InitialCheckpointHashPersister = {
	checkpointHashPersistenceChain: Promise<void>
	persistCheckpointHashToMessage(messageIndex: number, commitHash: string): Promise<void>
}

describe("Task initial checkpoint hash persistence", () => {
	it("flushes the checkpoint row before publishing the updated state", async () => {
		const updateClineMessage = vi.fn().mockResolvedValue(undefined)
		const flushMessageUpdate = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const fakeTask = {
			taskState: { abort: false },
			checkpointHashPersistenceChain: Promise.resolve(),
			messageStateHandler: { updateClineMessage, flushMessageUpdate },
			postStateToWebview,
		}

		await (Task.prototype as unknown as InitialCheckpointHashPersister).persistCheckpointHashToMessage.call(
			fakeTask,
			3,
			"initial-checkpoint-hash",
		)

		expect(updateClineMessage).toHaveBeenCalledWith(3, { lastCheckpointHash: "initial-checkpoint-hash" })
		expect(updateClineMessage.mock.invocationCallOrder[0]).toBeLessThan(flushMessageUpdate.mock.invocationCallOrder[0])
		expect(flushMessageUpdate.mock.invocationCallOrder[0]).toBeLessThan(postStateToWebview.mock.invocationCallOrder[0])
	})

	it("does not publish a checkpoint hash when its durable flush fails", async () => {
		const flushError = new Error("checkpoint_jsonl_flush_failed")
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const fakeTask = {
			taskState: { abort: false },
			checkpointHashPersistenceChain: Promise.resolve(),
			messageStateHandler: {
				updateClineMessage: vi.fn().mockResolvedValue(undefined),
				flushMessageUpdate: vi.fn().mockRejectedValue(flushError),
			},
			postStateToWebview,
		}

		await expect(
			(Task.prototype as unknown as InitialCheckpointHashPersister).persistCheckpointHashToMessage.call(
				fakeTask,
				0,
				"initial-checkpoint-hash",
			),
		).rejects.toBe(flushError)
		expect(postStateToWebview).not.toHaveBeenCalled()
	})

	it("registers an in-flight hash write synchronously so termination can await only the message-store work", async () => {
		let releaseUpdate!: () => void
		const updateGate = new Promise<void>((resolve) => {
			releaseUpdate = resolve
		})
		const updateClineMessage = vi.fn(async () => updateGate)
		const flushMessageUpdate = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const initialChain = Promise.resolve()
		const fakeTask = {
			taskState: { abort: false },
			checkpointHashPersistenceChain: initialChain,
			messageStateHandler: { updateClineMessage, flushMessageUpdate },
			postStateToWebview,
		}

		const persistence = (Task.prototype as unknown as InitialCheckpointHashPersister).persistCheckpointHashToMessage.call(
			fakeTask,
			1,
			"initial-checkpoint-hash",
		)
		const registeredChain = fakeTask.checkpointHashPersistenceChain
		await vi.waitFor(() => expect(updateClineMessage).toHaveBeenCalledOnce())
		expect(registeredChain).not.toBe(initialChain)

		fakeTask.taskState.abort = true
		await (Task.prototype as unknown as InitialCheckpointHashPersister).persistCheckpointHashToMessage.call(
			fakeTask,
			2,
			"late-checkpoint-hash",
		)
		expect(updateClineMessage).toHaveBeenCalledOnce()

		releaseUpdate()
		await expect(registeredChain).resolves.toBeUndefined()
		await expect(persistence).resolves.toBeUndefined()
		expect(flushMessageUpdate).toHaveBeenCalledOnce()
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})

	it("skips the write once the task is aborting so it cannot touch a closed store", async () => {
		// The baseline commit resolves off the request path, so it can return after
		// terminate already closed the message store as its durability boundary.
		const updateClineMessage = vi.fn().mockResolvedValue(undefined)
		const flushMessageUpdate = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const fakeTask = {
			taskState: { abort: true },
			checkpointHashPersistenceChain: Promise.resolve(),
			messageStateHandler: { updateClineMessage, flushMessageUpdate },
			postStateToWebview,
		}

		await (Task.prototype as unknown as InitialCheckpointHashPersister).persistCheckpointHashToMessage.call(
			fakeTask,
			2,
			"initial-checkpoint-hash",
		)

		expect(updateClineMessage).not.toHaveBeenCalled()
		expect(flushMessageUpdate).not.toHaveBeenCalled()
		expect(postStateToWebview).not.toHaveBeenCalled()
	})
})
