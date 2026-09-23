import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { UIMessage } from "@/core/storage/UIMessage"
import { UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"
import { TaskActivityPersistence } from "@/core/task/activity/TaskActivityPersistence"
import { TaskActivityStore } from "@/core/task/activity/TaskActivityStore"
import type { TaskRuntimeState } from "@/core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@/core/task/TaskPhase"
import { createSnapshot } from "@/core/task/TaskSnapshot"
import { HistoryDisplaySession } from "../HistoryDisplaySession"

function createHistoryItem(taskId: string): HistoryItem {
	return {
		id: taskId,
		ts: 1,
		task: `History ${taskId}`,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}
}

async function seedMessages(taskId: string, messages: readonly ClineMessage[]): Promise<void> {
	const store = await UIMessage.open(taskId)
	try {
		for (const message of messages) await store.addMessage({ ...message })
		await store.flush()
	} finally {
		await store.close()
	}
}

async function persistSnapshot(taskId: string, state: TaskRuntimeState): Promise<void> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	await fs.writeFile(path.join(taskDirectory, GlobalFileNames.taskSnapshot), JSON.stringify(createSnapshot(state, 200)), "utf8")
}

function requestFor(
	session: HistoryDisplaySession,
	overrides: Partial<DispatchInteractionRequest> = {},
): DispatchInteractionRequest {
	const interaction = session.getViewState().activeInteraction
	if (!interaction) throw new Error("Expected an active history interaction")
	return DispatchInteractionRequest.create({
		taskId: interaction.taskId,
		turnId: interaction.turnId,
		interactionId: interaction.interactionId,
		actionId: "resume",
		stateRevision: interaction.stateRevision,
		...overrides,
	})
}

describe("HistoryDisplaySession", () => {
	let dlineDocsDir: string

	beforeEach(async () => {
		dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-history-display-"))
		vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await fs.rm(dlineDocsDir, { recursive: true, force: true })
	})

	it("projects one synthetic Resume interaction when no canonical snapshot exists", async () => {
		const taskId = "history-synthetic-resume"
		await seedMessages(taskId, [{ ts: 10, type: "say", say: "task", text: "Original task" }])
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			const view = session.getViewState()
			expect(session.isLoaded).toBe(true)
			expect(view.activeInteraction).toMatchObject({
				taskId,
				turnId: `history-display:${taskId}`,
				interactionId: `history-display:${taskId}:resume`,
				kind: "resume",
				status: "awaiting",
				stateRevision: 0,
				anchorVerified: true,
			})
			expect(session.getMessages()).toEqual([
				expect.objectContaining({ ts: 10, type: "say", say: "task" }),
				expect.objectContaining({ type: "ask", ask: "resume_task", partial: false }),
			])
			expect(session.accepts(requestFor(session))).toBe(true)
			expect(session.accepts(requestFor(session, { stateRevision: 1 }))).toBe(false)
			expect(session.accepts(requestFor(session, { interactionId: "stale-interaction" }))).toBe(false)
		} finally {
			await session.dispose()
		}
	})

	it("hydrates persisted activities for the lightweight history surface", async () => {
		const taskId = "history-activities"
		await seedMessages(taskId, [{ ts: 10, type: "say", say: "task", text: "Original task" }])
		const persistedStore = new TaskActivityStore(taskId, new TaskActivityPersistence(taskId))
		persistedStore.create({
			activityId: "history-subagent",
			kind: "subagent",
			executionMode: "foreground",
			title: "history review",
		})
		persistedStore.update("history-subagent", {
			status: "cancelled",
			metrics: { toolCalls: 4, inputTokens: 40, outputTokens: 8 },
		})
		await persistedStore.waitForPersistence()
		persistedStore.dispose()
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()
			expect(session.activityStore.list()).toEqual([
				expect.objectContaining({
					activityId: "history-subagent",
					status: "cancelled",
					metrics: expect.objectContaining({ toolCalls: 4, inputTokens: 40, outputTokens: 8 }),
				}),
			])
		} finally {
			await session.dispose()
		}
	})

	it("preserves canonical awaiting interaction identity when the durable anchor matches", async () => {
		const taskId = "history-canonical-resume"
		const turnId = "turn-canonical"
		const interactionId = "interaction-canonical"
		const anchorTs = 100
		await seedMessages(taskId, [
			{
				ts: anchorTs,
				type: "ask",
				ask: "resume_task",
				text: "",
				partial: false,
				interactionId,
			},
		])
		await persistSnapshot(taskId, {
			taskId,
			phase: TaskPhase.CANCELLING,
			revision: 7,
			anchor: { apiIndex: 4, uiMessageTs: anchorTs, turnId, interactionId },
			interaction: {
				taskId,
				turnId,
				interactionId,
				kind: "resume",
				status: "awaiting",
				createdRevision: 6,
				anchor: { messageTs: anchorTs, messageType: "ask", taskAsk: "resume_task" },
			},
			cancellation: { source: "system", fromPhase: TaskPhase.PAUSED },
		})
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			expect(session.getViewState().activeInteraction).toMatchObject({
				taskId,
				turnId,
				interactionId,
				kind: "resume",
				stateRevision: 7,
				anchorVerified: true,
			})
			expect(session.getMessages()).toHaveLength(1)
			expect(session.accepts(requestFor(session))).toBe(true)
		} finally {
			await session.dispose()
		}
	})

	it("fails closed when a canonical approval anchor is still partial", async () => {
		const taskId = "history-partial-approval"
		const turnId = "turn-partial-approval"
		const interactionId = "interaction-partial-approval"
		const anchorTs = 100
		const taskDirectory = await ensureTaskDirectoryExists(taskId)
		const partialAnchor: ClineMessage = {
			ts: anchorTs,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "readFile", path: "" }),
			partial: true,
			interactionId,
		}
		await fs.writeFile(path.join(taskDirectory, GlobalFileNames.uiMessages), `${JSON.stringify(partialAnchor)}\n`, "utf8")
		await persistSnapshot(taskId, {
			taskId,
			phase: TaskPhase.CANCELLING,
			revision: 7,
			anchor: { apiIndex: 4, uiMessageTs: anchorTs, turnId, interactionId },
			interaction: {
				taskId,
				turnId,
				interactionId,
				kind: "tool_approval",
				status: "awaiting",
				createdRevision: 6,
				anchor: { messageTs: anchorTs, messageType: "ask", taskAsk: "tool" },
			},
			cancellation: { source: "system", fromPhase: TaskPhase.AWAITING_APPROVAL },
		})
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			const view = session.getViewState()
			expect(view.activeInteraction).toBeUndefined()
			expect(view.input).toEqual({ enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false })
			expect(view.footer.actions).toEqual([])
			expect(view.diagnostic).toEqual({ code: "interaction_anchor_missing", interactionId })
			expect(session.getMessages()).toEqual([partialAnchor])
		} finally {
			await session.dispose()
		}
	})

	it("retains only the latest window while serving absolute historical pages", async () => {
		const taskId = "history-window-pages"
		await seedMessages(
			taskId,
			Array.from(
				{ length: 260 },
				(_, index): ClineMessage => ({
					ts: index + 1,
					type: "say",
					say: index === 0 ? "task" : "text",
					text: `message-${index}`,
				}),
			),
		)
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			expect(session.getMessageCount()).toBe(261)
			expect(session.getMessages()).toHaveLength(201)
			expect(session.getTaskTitleMessage()).toMatchObject({ ts: 1, say: "task" })
			await expect(session.fetchMessages(0, 2)).resolves.toMatchObject({
				startIndex: 0,
				totalCount: 261,
				messages: [{ ts: 1 }, { ts: 2 }],
			})
			await expect(session.fetchMessages(-1, 2)).resolves.toMatchObject({
				startIndex: 259,
				messages: [{ ts: 260 }, { type: "ask", ask: "resume_task" }],
			})
		} finally {
			await session.dispose()
		}
	})

	it("closes an untransferred window reader once when the display is cleared", async () => {
		const session = new HistoryDisplaySession(createHistoryItem("history-display-close"))
		const closeSpy = vi.spyOn(UIMessageWindowReader.prototype, "close")
		await session.load()

		await session.dispose()
		await session.dispose()

		expect(closeSpy).toHaveBeenCalledOnce()
		expect(session.getMessages()).toEqual([])
	})

	it("closes a reader that opens after panel disposal instead of reattaching it", async () => {
		let resolveOpen!: (reader: UIMessageWindowReader) => void
		const close = vi.fn(async () => undefined)
		const lateReader = { close } as unknown as UIMessageWindowReader
		const open = new Promise<UIMessageWindowReader>((resolve) => {
			resolveOpen = resolve
		})
		vi.spyOn(UIMessage, "openWindow").mockReturnValue(open)
		const session = new HistoryDisplaySession(createHistoryItem("history-late-open"))

		const loading = session.load()
		await session.dispose()
		resolveOpen(lateReader)
		await loading

		expect(close).toHaveBeenCalledOnce()
		expect(session.isLoaded).toBe(false)
		expect(session.getMessages()).toEqual([])
	})
})
