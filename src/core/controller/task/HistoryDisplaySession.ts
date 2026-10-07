import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { QueuedInputEntry } from "@shared/InputQueue"
import type { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { Logger } from "@shared/services/Logger"
import { InstanceDatabase, instanceDatabaseExists, openInstanceStorage, resolveInstanceLayout } from "@/core/storage/instance"
import { UIMessage } from "@/core/storage/UIMessage"
import type { UIMessageWindowPage, UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"
import { TaskActivityPersistence } from "@/core/task/activity/TaskActivityPersistence"
import { TaskActivityStore } from "@/core/task/activity/TaskActivityStore"
import { readFocusChainHistoryFile } from "@/core/task/focus-chain/file-utils"
import { readHistoryContextWindowIndicator } from "@/core/task/HistoryContextWindow"
import { getInteraction } from "@/core/task/interaction/InteractionRegistry"
import { createInitialTaskState, type TaskState } from "@/core/task/kernel"
import type { ApiRateSnapshot } from "@/core/task/performance/api-rate-tracker"
import { TaskPerformanceOwner } from "@/core/task/performance/TaskPerformanceOwner"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "@/core/task/performance/task-rate-metrics-types"
import { FileTaskStateVault, openTaskPayloadStore } from "@/core/task/stores"
import { TaskPhase } from "@/core/task/TaskPhase"
import { projectCanonicalTaskView } from "@/core/task/view/canonical/projectCanonicalTaskView"
import { projectHistoryDisplayState } from "@/core/task/view/canonical/projectHistoryDisplayState"
import { historyDisplayAnchorRow } from "@/core/task/view/historyDisplayAnchorRow"
import { materializeCanonicalInputQueue } from "@/core/task/view/materializeCanonicalInputQueue"
import { projectHistoryPreparingView } from "./history-task-readiness"
import { adaptCanonicalTaskView, anchoredInteractionId } from "./TaskViewMessageAdapter"

/**
 * Lightweight owner for a historical surface before the user resumes execution.
 *
 * It deliberately owns only the durable UI history and activity snapshot needed
 * to render the panel, plus a snapshot-derived interaction projection. API
 * history, Task runtime services, locks, terminals, browser sessions, and
 * orchestrator registration are created only when the user dispatches an action
 * and the Controller promotes the session into a real Task.
 */
const HISTORY_MESSAGE_WINDOW_SIZE = 200
const HISTORY_INPUT_QUEUE_READER = "history-input-queue-reader"

export interface HistoryDisplayLoadOptions {
	/**
	 * Resolves true once the lock check shows no other instance holds the task.
	 *
	 * Work the task left running then has no owner left to finish it, so the
	 * display records it as interrupted, as opening a task did before the
	 * display existed. A task another instance holds keeps its running work.
	 */
	readonly ownerless?: Promise<boolean>
	/**
	 * Told which window rows the background maintenance settled, after the
	 * surface was already shown, so the chat can redraw them.
	 */
	readonly onMaintained?: (rows: readonly UiMessage[]) => Promise<void> | void
}

/** A command row still showing work whose activity was found interrupted. */
function isInterruptedCommandCard(message: UiMessage, activityIds: ReadonlySet<string>): boolean {
	return (
		message.activityId !== undefined &&
		activityIds.has(message.activityId) &&
		(message.commandStatus === "pending" || message.commandStatus === "running")
	)
}

export class HistoryDisplaySession {
	readonly activityStore: TaskActivityStore
	/** The occupancy the task last showed, drawn by the header until the task runs again. */
	private readonly contextWindowIndicator: ContextWindowIndicatorSnapshot | undefined
	/**
	 * `activities.db` admits one writer, and opening it is what claims that
	 * role. A display only reads, so it releases the database as soon as the
	 * snapshot is hydrated: holding it would refuse the Task this display is
	 * promoted into, and any other window opening the same task.
	 */
	private readonly activityPersistence: TaskActivityPersistence
	private messageReader?: UIMessageWindowReader
	/** The metrics a past run recorded, read so the header and chart show them before resume. */
	private performance?: TaskPerformanceOwner
	private focusChainHistory: string | null = null
	private messages: UiMessage[] = []
	private durableMessageCount = 0
	private syntheticMessage?: UiMessage
	private taskTitleMessage?: UiMessage
	private inputQueue: QueuedInputEntry[] = []
	private viewState: TaskViewState
	private locked = false
	private loaded = false
	private disposed = false
	/** Activity hydration and orphan recovery, which run after the surface is shown. */
	private maintenance: Promise<void> = Promise.resolve()

	constructor(readonly historyItem: HistoryItem) {
		this.activityPersistence = new TaskActivityPersistence(historyItem.id)
		this.activityStore = new TaskActivityStore(historyItem.id, this.activityPersistence)
		this.viewState = projectHistoryPreparingView({ taskId: historyItem.id, phase: TaskPhase.IDLE, revision: 0 })
		this.contextWindowIndicator = readHistoryContextWindowIndicator(historyItem.contextWindowIndicator, historyItem.id)
	}

	get taskId(): string {
		return this.historyItem.id
	}

	get isLoaded(): boolean {
		return this.loaded
	}

	async load(options?: HistoryDisplayLoadOptions): Promise<void> {
		if (this.loaded || this.disposed) return

		const reader = await UIMessage.openWindow(this.taskId)
		if (this.disposed) {
			await reader.close()
			return
		}
		this.messageReader = reader
		try {
			const [latestMessages, snapshot, taskTitlePage, performance, focusChainHistory] = await Promise.all([
				reader.getLatest(HISTORY_MESSAGE_WINDOW_SIZE),
				this.readSnapshot(),
				reader.getPage(0, 1),
				this.openMetrics(),
				this.readFocusChainHistory(),
			])
			this.performance = performance
			this.focusChainHistory = focusChainHistory
			if (this.disposed) {
				await this.releaseMetrics()
				return
			}
			const inputQueue = await this.readInputQueue(snapshot)
			if (this.disposed) return
			const projected = await this.projectSnapshot(reader, snapshot, latestMessages)
			if (this.disposed) return
			this.durableMessageCount = reader.count
			this.syntheticMessage = projected.syntheticMessage
			this.messages = projected.messages
			this.taskTitleMessage = taskTitlePage.messages[0]
			this.inputQueue = [...inputQueue]
			this.viewState = projected.view
			this.loaded = true
			this.maintenance = this.maintain(options)
		} catch (error) {
			if (this.messageReader === reader) this.messageReader = undefined
			await reader.close().catch(() => undefined)
			if (this.disposed) return
			throw error
		}
	}

	/** Resolves once the activity hydration and orphan recovery that follow `load` finished. */
	whenMaintained(): Promise<void> {
		return this.maintenance
	}

	/** The focusChain history the task recorded, or null when it never recorded one. */
	getFocusChainHistory(): string | null {
		return this.focusChainHistory
	}

	/** Rates the task last recorded, or undefined when it never recorded any. */
	getRateSnapshot(): ApiRateSnapshot | undefined {
		return this.performance?.getSnapshot()
	}

	/** Query the recorded rate history, or undefined when the task never recorded any. */
	queryRateMetrics(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult> | undefined {
		return this.performance?.query(query)
	}

	getMessages(): readonly UiMessage[] {
		return this.messages
	}

	getMessageCount(): number {
		return this.durableMessageCount + (this.syntheticMessage ? 1 : 0)
	}

	getTaskTitleMessage(): UiMessage | undefined {
		return this.taskTitleMessage
	}

	getContextWindowIndicator(): ContextWindowIndicatorSnapshot | undefined {
		return this.contextWindowIndicator
	}

	/** Retained input projected from the same immutable snapshot as the history interaction. */
	getInputQueue(): readonly QueuedInputEntry[] {
		return this.inputQueue
	}

	async fetchMessages(referenceIndex: number, count: number): Promise<UIMessageWindowPage> {
		const reader = this.messageReader
		if (!reader) return { messages: [], totalCount: 0, startIndex: 0 }
		const totalCount = this.getMessageCount()
		const pageSize = Math.max(0, Math.trunc(count))
		const startIndex =
			referenceIndex === -1
				? Math.max(0, totalCount - pageSize)
				: Math.max(0, Math.min(Math.trunc(referenceIndex), totalCount))
		const endIndex = Math.min(startIndex + pageSize, totalCount)
		const durableEndIndex = Math.min(endIndex, this.durableMessageCount)
		const durableCount = Math.max(0, durableEndIndex - startIndex)
		const messages = durableCount > 0 ? (await reader.getPage(startIndex, durableCount)).messages : []
		if (this.syntheticMessage && startIndex <= this.durableMessageCount && endIndex > this.durableMessageCount) {
			messages.push(this.syntheticMessage)
		}
		return { messages, totalCount, startIndex }
	}

	getViewState(): TaskViewState {
		if (!this.locked) return this.viewState
		return {
			...this.viewState,
			input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
			footer: {
				actions: this.viewState.footer.actions.map((action) => ({ ...action, enabled: false })),
			},
		}
	}

	markLocked(): void {
		this.locked = true
	}

	/** Restore the writable projection once this window owns the task lock. */
	markUnlocked(): void {
		this.locked = false
	}

	isLocked(): boolean {
		return this.locked
	}

	accepts(request: DispatchInteractionRequest): boolean {
		if (this.locked) return false
		const interaction = this.viewState.activeInteraction
		if (
			!interaction ||
			request.taskId !== interaction.taskId ||
			request.turnId !== interaction.turnId ||
			request.interactionId !== interaction.interactionId ||
			request.stateRevision !== interaction.stateRevision
		) {
			return false
		}
		const definition = getInteraction(interaction.kind as Parameters<typeof getInteraction>[0])
		return (
			definition.actions.some((action) => action.type === request.actionId) ||
			definition.input.enterAction === request.actionId
		)
	}

	async dispose(): Promise<void> {
		this.disposed = true
		// activities.db admits one writer; recovery hands it back before the
		// store is torn down and the promoted Task opens it.
		await this.maintenance
		this.activityStore.dispose()
		const reader = this.messageReader
		this.messageReader = undefined
		this.messages = []
		this.syntheticMessage = undefined
		this.taskTitleMessage = undefined
		this.inputQueue = []
		this.durableMessageCount = 0
		await Promise.all([reader?.close(), this.releaseActivities(), this.releaseMetrics()])
	}

	/**
	 * Hydrate activities and settle orphaned work once the surface is shown.
	 *
	 * Recovery waits on the lock check and rewrites the message store, which
	 * held the first frame of a long task for seconds. Nothing the surface
	 * draws first depends on it, so it runs afterwards and reports the rows it
	 * settled so the chat can redraw them.
	 */
	private async maintain(options?: HistoryDisplayLoadOptions): Promise<void> {
		try {
			const interrupted = await this.hydrateActivities(options?.ownerless)
			if (this.disposed || interrupted.size === 0) return
			await this.settleInterruptedCommandCards(interrupted)
			if (this.disposed) return
			const settled: UiMessage[] = []
			this.messages = this.messages.map((message) => {
				if (!isInterruptedCommandCard(message, interrupted)) return message
				const row: UiMessage = { ...message, commandStatus: "interrupted" }
				settled.push(row)
				return row
			})
			if (settled.length > 0) await options?.onMaintained?.(settled)
		} catch (error) {
			Logger.warn(`[HistoryDisplay] Background maintenance failed for task ${this.taskId}:`, error)
		}
	}

	/**
	 * Read the persisted activities, then give `activities.db` back to its writer.
	 *
	 * Recovery runs inside the same writer window, so an ownerless task's
	 * orphaned work is recorded as interrupted before the database is released.
	 */
	private async hydrateActivities(ownerless: Promise<boolean> | undefined): Promise<ReadonlySet<string>> {
		try {
			await this.activityStore.hydrate()
			return await this.recoverOrphanedActivities(ownerless)
		} finally {
			await this.releaseActivities()
		}
	}

	private async recoverOrphanedActivities(ownerless: Promise<boolean> | undefined): Promise<ReadonlySet<string>> {
		if (!ownerless || !(await ownerless) || this.disposed) return new Set()
		try {
			return new Set(await this.activityStore.recoverInterruptedActivities())
		} catch (error) {
			Logger.warn(`[HistoryDisplay] Failed to recover interrupted activities for task ${this.taskId}:`, error)
			return new Set()
		}
	}

	/**
	 * Settle the command rows of interrupted activities durably.
	 *
	 * The row is what the chat draws, so a row left running would keep offering
	 * Cancel for a process nobody owns. A failed write still shows the row as
	 * interrupted in the window: its activity already is.
	 */
	private async settleInterruptedCommandCards(activityIds: ReadonlySet<string>): Promise<void> {
		try {
			const store = await UIMessage.open(this.taskId)
			try {
				for (const [index, message] of store.getAll().entries()) {
					if (isInterruptedCommandCard(message, activityIds)) {
						await store.updateMessage(index, { commandStatus: "interrupted" })
					}
				}
			} finally {
				await store.close()
			}
		} catch (error) {
			Logger.warn(`[HistoryDisplay] Failed to settle interrupted command rows for task ${this.taskId}:`, error)
		}
	}

	private async openMetrics(): Promise<TaskPerformanceOwner | undefined> {
		try {
			return await TaskPerformanceOwner.openExisting({
				taskId: this.taskId,
				// A display never runs a provider round, so no live state is ever read.
				readState: () => createInitialTaskState(this.taskId),
				legacyMessages: () => this.messages,
			})
		} catch (error) {
			Logger.warn(
				`[HistoryDisplaySession] Could not read metrics for ${this.taskId}: ${error instanceof Error ? error.message : String(error)}`,
			)
			return undefined
		}
	}

	private async releaseMetrics(): Promise<void> {
		const performance = this.performance
		this.performance = undefined
		await performance?.release()
	}

	private async releaseActivities(): Promise<void> {
		try {
			await this.activityPersistence.close()
		} catch (error) {
			Logger.warn(`[HistoryDisplay] Failed to release activities for task ${this.taskId}:`, error)
		}
	}

	/** A history the view cannot read only loses its focusChain panel, never the task. */
	private async readFocusChainHistory(): Promise<string | null> {
		try {
			return await readFocusChainHistoryFile(this.taskId)
		} catch (error) {
			Logger.warn(
				`[HistoryDisplaySession] ${this.taskId}: focus chain history unreadable: ${error instanceof Error ? error.message : String(error)}`,
			)
			return null
		}
	}

	private async readSnapshot(): Promise<TaskState | undefined> {
		try {
			// Reading a historical snapshot must not create directories for a task being viewed.
			const layout = await resolveInstanceLayout({ taskId: this.taskId })
			return (await new FileTaskStateVault(layout.stateFile).load(this.taskId))?.state
		} catch {
			return undefined
		}
	}

	private async readInputQueue(snapshot: TaskState | undefined): Promise<readonly QueuedInputEntry[]> {
		const hasVisibleInput = snapshot?.intake.queued.some(
			(entry) =>
				entry.source === "user" &&
				entry.queue !== undefined &&
				(entry.state === "accepted" || entry.state === "released"),
		)
		if (!snapshot || !hasVisibleInput) return []

		const layout = await resolveInstanceLayout({ taskId: this.taskId })
		if (!(await instanceDatabaseExists(layout, InstanceDatabase.Journal))) return []
		const storage = openInstanceStorage(layout.root)
		try {
			const database = await storage.openDatabase(InstanceDatabase.Journal, HISTORY_INPUT_QUEUE_READER)
			return await materializeCanonicalInputQueue(snapshot, await openTaskPayloadStore(database))
		} catch (error) {
			Logger.warn(`[HistoryDisplay] Failed to read retained input for task ${this.taskId}:`, error)
			return []
		} finally {
			await storage.close()
		}
	}

	/**
	 * Render the stopped task from its durable state. A snapshot that never
	 * reached an interaction still owes the user a way back in, so the display
	 * projection synthesizes one and this method supplies its anchor row.
	 */
	private async projectSnapshot(
		reader: UIMessageWindowReader,
		snapshot: TaskState | undefined,
		durableMessages: UiMessage[],
	): Promise<{ messages: UiMessage[]; view: TaskViewState; syntheticMessage?: UiMessage }> {
		const display = projectHistoryDisplayState(this.taskId, snapshot)
		if (!display.synthetic) {
			const view = projectCanonicalTaskView(display.state)
			const anchor = await this.findAnchorOutsideWindow(reader, anchoredInteractionId(view), durableMessages)
			// The anchor only proves the dialog is answerable; the retained window
			// stays the latest page, and the surface pages back to the row itself.
			const evidence = anchor ? [...durableMessages, anchor] : durableMessages
			return { messages: durableMessages, view: adaptCanonicalTaskView(view, evidence) }
		}
		const syntheticMessage = historyDisplayAnchorRow(display.synthetic, durableMessages)
		const messages = [...durableMessages, syntheticMessage]
		return { messages, view: this.projectView(display.state, messages), syntheticMessage }
	}

	private projectView(state: TaskState, messages: readonly UiMessage[]): TaskViewState {
		return adaptCanonicalTaskView(projectCanonicalTaskView(state), messages)
	}

	/**
	 * Find the ask row a stopped dialog anchors to when later rows have pushed it
	 * out of the latest window. Rows inside the window always win, including a
	 * still-partial one, so a reveal that never finished keeps failing closed.
	 */
	private async findAnchorOutsideWindow(
		reader: UIMessageWindowReader,
		interactionId: string | undefined,
		windowMessages: readonly UiMessage[],
	): Promise<UiMessage | undefined> {
		if (!interactionId) return undefined
		if (windowMessages.some((message) => message.type === "ask" && message.interactionId === interactionId)) return undefined
		try {
			const anchor = await reader.getLastAsk(interactionId)
			return anchor?.type === "ask" && anchor.interactionId === interactionId && !anchor.partial ? anchor : undefined
		} catch (error) {
			Logger.warn(`[HistoryDisplay] Failed to read the interaction anchor for task ${this.taskId}:`, error)
			return undefined
		}
	}
}
