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
import { createFocusChainMarkdownContent, getFocusChainFilePath } from "@/core/task/focus-chain/file-utils"
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

	it("restores Resume when the saved Resume interaction has no durable ask row", async () => {
		const taskId = "history-missing-resume-anchor"
		const interactionId = `resume:${taskId}:34:244`
		await seedMessages(taskId, [{ ts: 10, type: "say", say: "task", text: "Original task" }])
		await persistSnapshot(taskId, {
			taskId,
			phase: TaskPhase.PAUSED,
			revision: 244,
			anchor: { apiIndex: 34, uiMessageTs: 999, turnId: "turn-1", interactionId },
			interaction: {
				taskId,
				turnId: "turn-1",
				interactionId,
				kind: "resume",
				status: "awaiting",
				createdRevision: 244,
				anchor: { messageTs: 999, messageType: "ask" },
			},
		})
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			const view = session.getViewState()
			expect(view.activeInteraction).toMatchObject({ kind: "resume", status: "awaiting", anchorVerified: true })
			expect(view).not.toHaveProperty("diagnostic")
			expect(session.getMessages().at(-1)).toMatchObject({ type: "ask", ask: "resume_task", partial: false })
			expect(session.accepts(requestFor(session))).toBe(true)
		} finally {
			await session.dispose()
		}
	})

	it("loads historical context usage and the persisted TODO checklist before Resume", async () => {
		const taskId = "history-header-projection"
		const taskDirectory = await ensureTaskDirectoryExists(taskId)
		const checklist = "# Restore history header\n- [x] Investigate\n- [ ] Resume safely"
		await fs.writeFile(
			getFocusChainFilePath(taskDirectory, taskId),
			createFocusChainMarkdownContent(taskId, checklist),
			"utf8",
		)
		await seedMessages(taskId, [
			{ ts: 10, type: "say", say: "task", text: "Original task" },
			{
				ts: 20,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 40_000, tokensOut: 2_000, cacheWrites: 1_000, cacheReads: 7_000 }),
			},
		])
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			expect(session.getLastApiReqTotalTokens()).toBe(50_000)
			expect(session.getFocusChainChecklist()).toBe(checklist)
		} finally {
			await session.dispose()
		}
	})

	it("projects obsolete Hosted approval as a synthetic Resume without accepting the old Approve", async () => {
		const taskId = "history-legacy-hosted-approval"
		const legacyId = `hosted-web:${taskId}:0`
		await seedMessages(taskId, [
			{ ts: 10, type: "say", say: "task", text: "Original task" },
			{
				ts: 100,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "webSearch", content: "Legacy Hosted approval" }),
				interactionId: legacyId,
				conversationHistoryIndex: 0,
			},
		])
		await persistSnapshot(taskId, {
			taskId,
			phase: TaskPhase.AWAITING_APPROVAL,
			revision: 7,
			anchor: { apiIndex: 0, uiMessageTs: 100, turnId: legacyId, interactionId: legacyId },
			interaction: {
				taskId,
				turnId: legacyId,
				interactionId: legacyId,
				kind: "hosted_web_approval",
				status: "awaiting",
				createdRevision: 6,
				anchor: { messageTs: 100, messageType: "ask", taskAsk: "tool" },
			},
		})
		const session = new HistoryDisplaySession(createHistoryItem(taskId))
		try {
			await session.load()
			const interaction = session.getViewState().activeInteraction
			expect(interaction).toMatchObject({ kind: "resume", status: "awaiting", anchorVerified: true })
			expect(interaction?.interactionId).not.toBe(legacyId)
			expect(session.getMessages().at(-1)).toMatchObject({ type: "ask", ask: "resume_task" })
			expect(session.accepts(requestFor(session))).toBe(true)
			expect(session.accepts(requestFor(session, { interactionId: legacyId, actionId: "approve" }))).toBe(false)
		} finally {
			await session.dispose()
		}
	})

	it("opens the history surface even when persisted activities cannot be hydrated", async () => {
		const taskId = "history-activity-hydration-failure"
		await seedMessages(taskId, [{ ts: 10, type: "say", say: "task", text: "Original task" }])
		vi.spyOn(TaskActivityStore.prototype, "hydrate").mockRejectedValueOnce(new Error("activities unreadable"))
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await expect(session.load()).resolves.toBeUndefined()
			expect(session.getViewState().activeInteraction).toMatchObject({ kind: "resume", status: "awaiting" })
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

	it("falls back to a synthetic Resume when a canonical interaction anchor is incomplete", async () => {
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
			expect(view.activeInteraction).toMatchObject({
				taskId,
				kind: "resume",
				status: "awaiting",
				anchorVerified: true,
			})
			expect(view.input).toMatchObject({ enabled: true, enterAction: "resume" })
			expect(view.footer.actions.map((action) => action.type)).toEqual(["resume"])
			expect(view).not.toHaveProperty("diagnostic")
			expect(session.getMessages()).toEqual([
				partialAnchor,
				expect.objectContaining({ type: "ask", ask: "resume_task", partial: false }),
			])
			expect(session.accepts(requestFor(session))).toBe(true)
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

	it("renders the indexed task title before the durable header is loaded", async () => {
		const taskId = "history-provisional-title"
		await seedMessages(taskId, [{ ts: 10, type: "say", say: "task", text: "Durable header" }])
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			// The preparing surface must identify the task, otherwise the Webview
			// renders the home view until the history window has been read.
			const provisional = session.getTaskTitleMessage()
			expect(provisional).toMatchObject({ type: "say", say: "task", text: session.historyItem.task })
			expect(session.getViewState().activeInteraction).toBeUndefined()

			await session.load()
			expect(session.getTaskTitleMessage()).toMatchObject({ ts: 10, text: "Durable header" })
		} finally {
			await session.dispose()
		}
		expect(session.getTaskTitleMessage()).toBeUndefined()
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
