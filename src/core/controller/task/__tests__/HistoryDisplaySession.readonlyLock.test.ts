import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskLockService } from "@/core/locks/TaskLockService"
import { UIMessage } from "@/core/storage/UIMessage"
import { HistoryDisplaySession } from "../HistoryDisplaySession"

/**
 * Regression coverage for the read-only projection of a lightweight history
 * surface.
 *
 * Opening a task from History stopped building a Task and started building a
 * HistoryDisplaySession instead. That session never read the lock file, so a
 * task still held by another instance was presented as fully writable: no
 * warning banner, no force-unlock entry point, and an enabled composer.
 */

const FOREIGN_INSTANCE = "other-instance:4242"
const LOCAL_INSTANCE = "this-instance:1"

function createHistoryItem(taskId: string): HistoryItem {
	return { id: taskId, ts: 1, task: `History ${taskId}`, tokensIn: 0, tokensOut: 0, totalCost: 0 }
}

async function seedTaskMessage(taskId: string): Promise<void> {
	const store = await UIMessage.open(taskId)
	try {
		await store.addMessage({ ts: 10, type: "say", say: "task", text: "Original task" })
		await store.flush()
	} finally {
		await store.close()
	}
}

describe("HistoryDisplaySession read-only lock projection", () => {
	let dlineDocsDir: string
	let tasksRoot: string

	beforeEach(async () => {
		dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-history-lock-"))
		tasksRoot = path.join(dlineDocsDir, "tasks")
		vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await fs.rm(dlineDocsDir, { recursive: true, force: true })
	})

	it("reports a live foreign lock so the surface can enter read-only mode", async () => {
		const taskId = "history-foreign-lock"
		const foreign = new TaskLockService(tasksRoot, FOREIGN_INSTANCE)
		expect(await foreign.acquireTaskLock(taskId)).toBe(true)

		const local = new TaskLockService(tasksRoot, LOCAL_INSTANCE)
		const status = await local.checkTaskLock(taskId)

		// The owner identity is what distinguishes "someone else is running this"
		// from "this window already owns it", so it must survive the read.
		expect(status.isLocked).toBe(true)
		expect(status.lockedBy).toBe(FOREIGN_INSTANCE)
		expect(status.lockedBy).not.toBe(local.instanceAddress)
		expect(await local.acquireTaskLock(taskId)).toBe(false)
	})

	it("treats a lock this instance already holds as writable", async () => {
		const taskId = "history-own-lock"
		const local = new TaskLockService(tasksRoot, LOCAL_INSTANCE)
		expect(await local.acquireTaskLock(taskId)).toBe(true)

		const status = await local.checkTaskLock(taskId)
		expect(status.isLocked).toBe(true)
		expect(status.lockedBy).toBe(local.instanceAddress)
	})

	it("disables input and footer actions while the display is locked", async () => {
		const taskId = "history-locked-view"
		await seedTaskMessage(taskId)
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()
			const writable = session.getViewState()
			expect(writable.input.enabled).toBe(true)
			expect(writable.footer.actions.some((action) => action.enabled)).toBe(true)

			session.markLocked()

			const readOnly = session.getViewState()
			expect(session.isLocked()).toBe(true)
			expect(readOnly.input.enabled).toBe(false)
			expect(readOnly.input.acceptsText).toBe(false)
			expect(readOnly.footer.actions.every((action) => !action.enabled)).toBe(true)
		} finally {
			await session.dispose()
		}
	})

	it("restores the writable projection after the lock is taken over", async () => {
		const taskId = "history-unlocked-view"
		await seedTaskMessage(taskId)
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()
			const expected = session.getViewState()
			session.markLocked()

			// Force-unlock has to reach the session itself; otherwise the banner and
			// the disabled composer outlive an unlock that already succeeded.
			session.markUnlocked()

			const restored = session.getViewState()
			expect(session.isLocked()).toBe(false)
			expect(restored.input).toEqual(expected.input)
			expect(restored.footer).toEqual(expected.footer)
		} finally {
			await session.dispose()
		}
	})

	it("rejects interactions while locked and accepts them once unlocked", async () => {
		const taskId = "history-locked-interaction"
		await seedTaskMessage(taskId)
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()
			const interaction = session.getViewState().activeInteraction
			if (!interaction) throw new Error("Expected an active history interaction")
			const request = {
				taskId: interaction.taskId,
				turnId: interaction.turnId,
				interactionId: interaction.interactionId,
				actionId: "resume",
				stateRevision: interaction.stateRevision,
			} as Parameters<HistoryDisplaySession["accepts"]>[0]

			session.markLocked()
			expect(session.accepts(request)).toBe(false)

			session.markUnlocked()
			expect(session.accepts(request)).toBe(true)
		} finally {
			await session.dispose()
		}
	})
})
