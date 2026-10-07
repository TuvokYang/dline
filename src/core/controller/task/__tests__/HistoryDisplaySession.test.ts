import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "@/core/storage/instance"
import { UIMessage } from "@/core/storage/UIMessage"
import { UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"
import { TaskActivityPersistence } from "@/core/task/activity/TaskActivityPersistence"
import { TaskActivityStore } from "@/core/task/activity/TaskActivityStore"
import { createInitialTaskState, type DialogInteraction, type TaskState } from "@/core/task/kernel"
import { FileTaskStateVault, openTaskJournalStores } from "@/core/task/stores"
import { encodeTaskPayload } from "@/core/task/stores/payload/TaskPayloadCodec"
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

async function seedMessages(taskId: string, messages: readonly UiMessage[]): Promise<void> {
	const store = await UIMessage.open(taskId)
	try {
		for (const message of messages) await store.addMessage({ ...message })
		await store.flush()
	} finally {
		await store.close()
	}
}

async function persistSnapshot(taskId: string, state: TaskState): Promise<void> {
	const layout = await ensureInstanceLayout({ taskId })
	await new FileTaskStateVault(layout.stateFile).save({ state, outbox: [] })
}

async function persistUserInputPayload(taskId: string): Promise<string> {
	const layout = await ensureInstanceLayout({ taskId })
	const storage = openInstanceStorage(layout.root)
	try {
		const stores = await openTaskJournalStores(
			await storage.openDatabase(InstanceDatabase.Journal, "history-display-test-seed"),
		)
		return await stores.payloads.put(
			encodeTaskPayload({
				kind: "user_input",
				text: "Retained after restart",
				images: ["data:image/png;base64,retained"],
				files: ["retained.txt"],
				activeQuote: "durable quote",
			}),
		)
	} finally {
		await storage.close()
	}
}

/** Write a state file in the retired runtime's shape, which no kernel reader accepts. */
async function writeLegacySnapshot(stateFile: string, snapshot: Record<string, unknown>): Promise<void> {
	await fs.writeFile(stateFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
}

/** `count` ordinary rows written after `afterTs`, enough to push earlier rows out of the latest window. */
function laterRows(afterTs: number, count: number): UiMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		ts: afterTs + index + 1,
		type: "say" as const,
		say: "text" as const,
		text: `later-${index}`,
	}))
}

/** A stopped turn whose one tool block still waits for a manual approval. */
function pendingApprovalState(taskId: string, turnId: string, blockId: string, interactionId: string): TaskState {
	return {
		...createInitialTaskState(taskId),
		revision: 7,
		flow: { phase: "waiting" },
		turn: {
			turnId,
			mode: "serial",
			blocks: [
				{
					blockId,
					index: 0,
					phase: "awaiting_approval",
					attempt: `attempt-${blockId}`,
					lanes: [],
					turnEnding: false,
					invocationRef: `invocation:${blockId}`,
				},
			],
			manualApprovalBlockIds: [blockId],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
		dialog: {
			approvalsByBlock: {
				[blockId]: {
					turnId,
					interactionId,
					kind: "tool_approval",
					status: "awaiting",
					createdRevision: 6,
					presentationRef: interactionId,
					actionRules: [
						{ actionId: "approve", payloadPolicy: "draft" },
						{ actionId: "reject", payloadPolicy: "draft" },
					],
					blockId,
					receiverGeneration: 0,
				},
			},
		},
	}
}

function stoppedState(taskId: string, revision: number, primary: DialogInteraction): TaskState {
	return {
		...createInitialTaskState(taskId),
		revision,
		flow: { phase: "paused" },
		dialog: { primary, approvalsByBlock: {} },
	}
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

	it("draws the context-window figure the task last showed and ignores one saved for another task", () => {
		const taskId = "history-context-window"
		const saved = {
			taskId,
			revision: 9,
			epoch: 2,
			phase: "receiving",
			durableContextTokens: 12_000,
			pendingSendTokens: 0,
			receivingTokens: 400,
			stagedTokens: 600,
			environmentTokens: 900,
			contextWindow: 200_000,
			mode: "act",
			updatedAt: 1,
			lineage: { kind: "ordinary", requestId: "turn-2", requestSequence: 2, attemptId: "turn-2" },
		} as const

		const session = new HistoryDisplaySession({ ...createHistoryItem(taskId), contextWindowIndicator: saved })
		expect(session.getContextWindowIndicator()).toMatchObject({
			taskId,
			phase: "stable",
			revision: 9,
			receivingTokens: 0,
			environmentTokens: 900,
			contextWindow: 200_000,
		})

		const foreign = new HistoryDisplaySession({
			...createHistoryItem(taskId),
			contextWindowIndicator: { ...saved, taskId: "another-task" },
		})
		expect(foreign.getContextWindowIndicator()).toBeUndefined()
		expect(new HistoryDisplaySession(createHistoryItem(taskId)).getContextWindowIndicator()).toBeUndefined()
	})

	it("materializes retained input from the canonical snapshot without starting a Task runtime", async () => {
		const taskId = "history-retained-input"
		await seedMessages(taskId, [{ ts: 10, type: "say", say: "task", text: "Original task" }])
		const payloadRef = await persistUserInputPayload(taskId)
		await persistSnapshot(taskId, {
			...createInitialTaskState(taskId),
			revision: 4,
			flow: { phase: "paused" },
			intake: {
				queued: [
					{
						entryId: "retained-1",
						payloadRef,
						source: "user",
						mode: "steering",
						sequence: 3,
						queue: { editing: false },
						state: "accepted",
					},
				],
				background: [],
				coTask: [],
			},
		})
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			expect(session.getInputQueue()).toEqual([
				{
					id: "retained-1",
					text: "Retained after restart",
					images: ["data:image/png;base64,retained"],
					files: ["retained.txt"],
					activeQuote: "durable quote",
					mode: "steering",
					editing: false,
					sequence: 3,
				},
			])
		} finally {
			await session.dispose()
		}
	})

	it("projects a legacy Hosted approval snapshot as a synthetic Resume without accepting the old Approve", async () => {
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
		// A snapshot written by the retired runtime is not a kernel state, so the
		// display must fall back to Resume instead of reviving its approval.
		const layout = await ensureInstanceLayout({ taskId })
		await writeLegacySnapshot(layout.stateFile, {
			taskId,
			phase: "awaiting_approval",
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

	it("hydrates persisted activities for the lightweight history surface", async () => {
		const taskId = "history-activities"
		await seedMessages(taskId, [{ ts: 10, type: "say", say: "task", text: "Original task" }])
		// The seeding writer releases activities.db before the display opens it.
		const writer = new TaskActivityPersistence(taskId)
		const persistedStore = new TaskActivityStore(taskId, writer)
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
		await writer.close()
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()
			await session.whenMaintained()
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

	describe("work an earlier owner left running", () => {
		const command = "node long-running.js"

		async function seedRunningCommand(taskId: string): Promise<void> {
			await seedMessages(taskId, [
				{ ts: 10, type: "say", say: "task", text: "Original task" },
				{ ts: 11, type: "say", say: "command", text: command, activityId: "orphan", commandStatus: "running" },
			])
			const writer = new TaskActivityPersistence(taskId)
			const persistedStore = new TaskActivityStore(taskId, writer)
			persistedStore.create({ activityId: "orphan", kind: "command", executionMode: "background", title: command })
			persistedStore.update("orphan", { status: "running" })
			await persistedStore.waitForPersistence()
			persistedStore.dispose()
			await writer.close()
		}

		async function readDurable(taskId: string) {
			const persistence = new TaskActivityPersistence(taskId)
			const activities = new TaskActivityStore(taskId, persistence)
			const messages = await UIMessage.open(taskId)
			try {
				await activities.hydrate()
				return {
					activity: activities.get("orphan")?.status,
					row: messages.getAll().find((message) => message.activityId === "orphan")?.commandStatus,
				}
			} finally {
				activities.dispose()
				await persistence.close()
				await messages.close()
			}
		}

		it("records it as interrupted, durably and in the shown row, when no other instance holds the task", async () => {
			const taskId = "history-orphaned-command"
			await seedRunningCommand(taskId)
			const session = new HistoryDisplaySession(createHistoryItem(taskId))

			try {
				const redrawn: string[] = []
				await session.load({
					ownerless: Promise.resolve(true),
					onMaintained: (rows) => {
						redrawn.push(...rows.map((row) => row.commandStatus ?? ""))
					},
				})
				await session.whenMaintained()
				expect(session.activityStore.get("orphan")?.status).toBe("interrupted")
				// The settled row reaches the chat after the surface was shown.
				expect(redrawn).toEqual(["interrupted"])
				expect(session.getMessages().find((message) => message.activityId === "orphan")?.commandStatus).toBe(
					"interrupted",
				)
			} finally {
				await session.dispose()
			}
			expect(await readDurable(taskId)).toEqual({ activity: "interrupted", row: "interrupted" })
		})

		it("leaves it running when another instance holds the task", async () => {
			const taskId = "history-owned-command"
			await seedRunningCommand(taskId)
			const session = new HistoryDisplaySession(createHistoryItem(taskId))

			try {
				await session.load({ ownerless: Promise.resolve(false) })
				await session.whenMaintained()
				expect(session.activityStore.get("orphan")?.status).toBe("running")
				expect(session.getMessages().find((message) => message.activityId === "orphan")?.commandStatus).toBe("running")
			} finally {
				await session.dispose()
			}
			expect(await readDurable(taskId)).toEqual({ activity: "running", row: "running" })
		})
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
		await persistSnapshot(
			taskId,
			stoppedState(taskId, 7, {
				turnId,
				interactionId,
				kind: "resume",
				status: "prepared",
				createdRevision: 6,
				presentationRef: `resume:${taskId}:6`,
				actionRules: [{ actionId: "resume", payloadPolicy: "draft" }],
				receiverGeneration: 0,
			}),
		)
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

	it("keeps a canonical pending local approval actionable instead of synthesizing Resume", async () => {
		const taskId = "history-canonical-local-approval"
		const turnId = "turn-local-approval"
		const blockId = "block-local-web-search"
		const interactionId = "approval:dline_tid_local_web"
		const anchorTs = 100
		await seedMessages(taskId, [
			{
				ts: anchorTs,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "webSearch", path: "runtime-v2 approval" }),
				partial: false,
				interactionId,
			},
		])
		await persistSnapshot(taskId, {
			...createInitialTaskState(taskId),
			revision: 7,
			flow: { phase: "waiting" },
			turn: {
				turnId,
				mode: "serial",
				blocks: [
					{
						blockId,
						index: 0,
						phase: "awaiting_approval",
						attempt: "attempt-local-web",
						lanes: [],
						turnEnding: false,
						invocationRef: "invocation:local-web",
					},
				],
				manualApprovalBlockIds: [blockId],
				automaticApprovalBlockIds: [],
				executingBlockIds: [],
			},
			dialog: {
				approvalsByBlock: {
					[blockId]: {
						turnId,
						interactionId,
						kind: "tool_approval",
						status: "awaiting",
						createdRevision: 6,
						presentationRef: interactionId,
						actionRules: [
							{ actionId: "approve", payloadPolicy: "draft" },
							{ actionId: "reject", payloadPolicy: "draft" },
						],
						blockId,
						receiverGeneration: 0,
					},
				},
			},
		})
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			expect(session.getViewState().activeInteraction).toMatchObject({
				taskId,
				turnId,
				interactionId,
				kind: "tool_approval",
				status: "awaiting",
				stateRevision: 7,
				anchorVerified: true,
			})
			expect(session.getViewState().footer.actions.map((action) => action.type)).toEqual(["approve", "reject"])
			expect(session.getMessages()).toHaveLength(1)
			expect(session.getMessages()[0]).toMatchObject({ ts: anchorTs, interactionId, ask: "tool" })
			expect(session.accepts(requestFor(session, { actionId: "approve" }))).toBe(true)
			expect(session.accepts(requestFor(session))).toBe(false)
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
		const partialAnchor: UiMessage = {
			ts: anchorTs,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "readFile", path: "" }),
			partial: true,
			interactionId,
		}
		await fs.writeFile(path.join(taskDirectory, GlobalFileNames.uiMessages), `${JSON.stringify(partialAnchor)}\n`, "utf8")
		await persistSnapshot(
			taskId,
			stoppedState(taskId, 7, {
				turnId,
				interactionId,
				kind: "tool_approval",
				status: "awaiting",
				createdRevision: 6,
				presentationRef: `approval:${interactionId}`,
				actionRules: [
					{ actionId: "approve", payloadPolicy: "draft" },
					{ actionId: "reject", payloadPolicy: "draft" },
				],
				receiverGeneration: 0,
			}),
		)
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

	it("keeps an approval actionable when later rows push its anchor out of the latest window", async () => {
		const taskId = "history-anchor-outside-window"
		const turnId = "turn-old-approval"
		const blockId = "block-old-approval"
		const interactionId = "approval:dline_tid_old_approval"
		const anchorTs = 100
		await seedMessages(taskId, [
			{
				ts: anchorTs,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "old.txt" }),
				partial: false,
				interactionId,
			},
			...laterRows(anchorTs, 250),
		])
		await persistSnapshot(taskId, pendingApprovalState(taskId, turnId, blockId, interactionId))
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			const view = session.getViewState()
			expect(view.activeInteraction).toMatchObject({
				taskId,
				turnId,
				interactionId,
				kind: "tool_approval",
				status: "awaiting",
				askMessageTs: anchorTs,
				anchorVerified: true,
			})
			expect(view.diagnostic).toBeUndefined()
			expect(view.footer.actions.map((action) => action.type)).toEqual(["approve", "reject"])
			// The anchor is projection evidence only: the retained window stays the latest page.
			expect(session.getMessages()).toHaveLength(200)
			expect(session.getMessages().some((message) => message.interactionId === interactionId)).toBe(false)
			expect(session.accepts(requestFor(session, { actionId: "approve" }))).toBe(true)
		} finally {
			await session.dispose()
		}
	})

	it("fails closed when the anchor outside the latest window is still partial", async () => {
		const taskId = "history-partial-anchor-outside-window"
		const turnId = "turn-partial-old-approval"
		const blockId = "block-partial-old-approval"
		const interactionId = "approval:dline_tid_partial_old_approval"
		const anchorTs = 100
		await seedMessages(taskId, [
			{
				ts: anchorTs,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "" }),
				partial: true,
				interactionId,
			},
			...laterRows(anchorTs, 250),
		])
		await persistSnapshot(taskId, pendingApprovalState(taskId, turnId, blockId, interactionId))
		const session = new HistoryDisplaySession(createHistoryItem(taskId))

		try {
			await session.load()

			const view = session.getViewState()
			expect(view.activeInteraction).toBeUndefined()
			expect(view.input).toEqual({ enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false })
			expect(view.diagnostic).toEqual({ code: "interaction_anchor_missing", interactionId })
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
				(_, index): UiMessage => ({
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
