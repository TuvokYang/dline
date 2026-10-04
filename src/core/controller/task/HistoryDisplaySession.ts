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
import { getInteraction } from "@/core/task/interaction/InteractionRegistry"
import type { TaskState } from "@/core/task/kernel"
import { FileTaskStateVault, openTaskPayloadStore } from "@/core/task/stores"
import { TaskPhase } from "@/core/task/TaskPhase"
import { projectCanonicalTaskView } from "@/core/task/view/canonical/projectCanonicalTaskView"
import {
	type HistoryDisplayInteractionKind,
	projectHistoryDisplayState,
} from "@/core/task/view/canonical/projectHistoryDisplayState"
import { materializeCanonicalInputQueue } from "@/core/task/view/materializeCanonicalInputQueue"
import { projectHistoryPreparingView } from "./history-task-readiness"
import { adaptCanonicalTaskView } from "./TaskViewMessageAdapter"

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

export class HistoryDisplaySession {
	readonly activityStore: TaskActivityStore
	/**
	 * `activities.db` admits one writer, and opening it is what claims that
	 * role. A display only reads, so it releases the database as soon as the
	 * snapshot is hydrated: holding it would refuse the Task this display is
	 * promoted into, and any other window opening the same task.
	 */
	private readonly activityPersistence: TaskActivityPersistence
	private messageReader?: UIMessageWindowReader
	private messages: UiMessage[] = []
	private durableMessageCount = 0
	private syntheticMessage?: UiMessage
	private taskTitleMessage?: UiMessage
	private inputQueue: QueuedInputEntry[] = []
	private viewState: TaskViewState
	private locked = false
	private loaded = false
	private disposed = false

	constructor(readonly historyItem: HistoryItem) {
		this.activityPersistence = new TaskActivityPersistence(historyItem.id)
		this.activityStore = new TaskActivityStore(historyItem.id, this.activityPersistence)
		this.viewState = projectHistoryPreparingView({ taskId: historyItem.id, phase: TaskPhase.IDLE, revision: 0 })
	}

	get taskId(): string {
		return this.historyItem.id
	}

	get isLoaded(): boolean {
		return this.loaded
	}

	async load(): Promise<void> {
		if (this.loaded || this.disposed) return

		const reader = await UIMessage.openWindow(this.taskId)
		if (this.disposed) {
			await reader.close()
			return
		}
		this.messageReader = reader
		try {
			const [durableMessages, snapshot, taskTitlePage] = await Promise.all([
				reader.getLatest(HISTORY_MESSAGE_WINDOW_SIZE),
				this.readSnapshot(),
				reader.getPage(0, 1),
				this.hydrateActivities(),
			])
			if (this.disposed) return

			const inputQueue = await this.readInputQueue(snapshot)
			if (this.disposed) return
			const projected = this.projectSnapshot(snapshot, durableMessages)
			this.durableMessageCount = reader.count
			this.syntheticMessage = projected.syntheticMessage
			this.messages = projected.messages
			this.taskTitleMessage = taskTitlePage.messages[0]
			this.inputQueue = [...inputQueue]
			this.viewState = projected.view
			this.loaded = true
		} catch (error) {
			if (this.messageReader === reader) this.messageReader = undefined
			await reader.close().catch(() => undefined)
			if (this.disposed) return
			throw error
		}
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
		this.activityStore.dispose()
		const reader = this.messageReader
		this.messageReader = undefined
		this.messages = []
		this.syntheticMessage = undefined
		this.taskTitleMessage = undefined
		this.inputQueue = []
		this.durableMessageCount = 0
		await Promise.all([reader?.close(), this.releaseActivities()])
	}

	/** Read the persisted activities, then give `activities.db` back to its writer. */
	private async hydrateActivities(): Promise<void> {
		try {
			await this.activityStore.hydrate()
		} finally {
			await this.releaseActivities()
		}
	}

	private async releaseActivities(): Promise<void> {
		try {
			await this.activityPersistence.close()
		} catch (error) {
			Logger.warn(`[HistoryDisplay] Failed to release activities for task ${this.taskId}:`, error)
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
	private projectSnapshot(
		snapshot: TaskState | undefined,
		durableMessages: UiMessage[],
	): { messages: UiMessage[]; view: TaskViewState; syntheticMessage?: UiMessage } {
		const display = projectHistoryDisplayState(this.taskId, snapshot)
		if (!display.synthetic) {
			return { messages: durableMessages, view: this.projectView(display.state, durableMessages) }
		}
		const syntheticMessage: UiMessage = {
			ts: durableMessages.reduce((latest, message) => Math.max(latest, message.ts), 0) + 1,
			type: "ask",
			ask: historyDisplayTaskAsk(display.synthetic.kind),
			text: "",
			partial: false,
			interactionId: display.synthetic.interactionId,
		}
		const messages = [...durableMessages, syntheticMessage]
		return { messages, view: this.projectView(display.state, messages), syntheticMessage }
	}

	private projectView(state: TaskState, messages: readonly UiMessage[]): TaskViewState {
		return adaptCanonicalTaskView(projectCanonicalTaskView(state), messages)
	}
}

/** A completed task reopened from history asks to resume rather than replaying its completion row. */
function historyDisplayTaskAsk(kind: HistoryDisplayInteractionKind): UiMessage["ask"] {
	return kind === "completion" ? "resume_completed_task" : getInteraction(kind).taskAsk
}
