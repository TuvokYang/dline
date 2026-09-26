import fs from "node:fs/promises"
import path from "node:path"
import type { ClineMessage, TaskViewState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { matchesActiveInteractionAnchor } from "@shared/interaction-anchor"
import type { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { UIMessage } from "@/core/storage/UIMessage"
import type { UIMessageWindowPage, UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"
import { TaskActivityPersistence } from "@/core/task/activity/TaskActivityPersistence"
import { TaskActivityStore } from "@/core/task/activity/TaskActivityStore"
import type { ActiveInteraction } from "@/core/task/interaction/InteractionReducer"
import { getInteraction } from "@/core/task/interaction/InteractionRegistry"
import { normalizeStoppedTaskSnapshot } from "@/core/task/resume/ResumeReconciler"
import type { TaskRuntimeState } from "@/core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@/core/task/TaskPhase"
import { hydrateSnapshot, normalizeLegacyTaskSnapshot, type TaskSnapshot } from "@/core/task/TaskSnapshot"
import { projectMissingInteractionAnchor, projectTaskView } from "@/core/task/view/TaskViewProjector"
import { projectHistoryPreparingView } from "./history-task-readiness"

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

export class HistoryDisplaySession {
	readonly activityStore: TaskActivityStore
	private messageReader?: UIMessageWindowReader
	private messages: ClineMessage[] = []
	private durableMessageCount = 0
	private syntheticMessage?: ClineMessage
	private taskTitleMessage?: ClineMessage
	private viewState: TaskViewState
	private locked = false
	private loaded = false
	private disposed = false

	constructor(readonly historyItem: HistoryItem) {
		this.activityStore = new TaskActivityStore(historyItem.id, new TaskActivityPersistence(historyItem.id))
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
				this.activityStore.hydrate(),
			])
			if (this.disposed) return

			const projected = await this.projectSnapshot(snapshot, durableMessages, reader)
			if (this.disposed) return
			this.durableMessageCount = reader.count
			this.syntheticMessage = projected.syntheticMessage
			this.messages = projected.messages
			this.taskTitleMessage = taskTitlePage.messages[0]
			this.viewState = projected.view
			this.loaded = true
		} catch (error) {
			if (this.messageReader === reader) this.messageReader = undefined
			await reader.close().catch(() => undefined)
			if (this.disposed) return
			throw error
		}
	}

	getMessages(): readonly ClineMessage[] {
		return this.messages
	}

	getMessageCount(): number {
		return this.durableMessageCount + (this.syntheticMessage ? 1 : 0)
	}

	getTaskTitleMessage(): ClineMessage | undefined {
		return this.taskTitleMessage
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

	/** Leave read-only mode after this instance takes the task lock over. */
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
		this.durableMessageCount = 0
		if (reader) await reader.close()
	}

	private async readSnapshot(): Promise<TaskSnapshot | undefined> {
		try {
			const taskDirectory = await ensureTaskDirectoryExists(this.taskId)
			const raw = await fs.readFile(path.join(taskDirectory, GlobalFileNames.taskSnapshot), "utf8")
			return normalizeLegacyTaskSnapshot(JSON.parse(raw))
		} catch {
			return undefined
		}
	}

	private async projectSnapshot(
		snapshot: TaskSnapshot | undefined,
		durableMessages: ClineMessage[],
		reader: UIMessageWindowReader,
	): Promise<{ messages: ClineMessage[]; view: TaskViewState; syntheticMessage?: ClineMessage }> {
		const hydrated = this.tryHydrate(snapshot)
		// The lightweight view cannot authorize a retired Hosted capability approval;
		// promotion delegates request-tail validation to ResumeReconciler.
		if (hydrated?.interaction?.kind === "hosted_web_approval") {
			return this.projectSyntheticInteraction(durableMessages, "resume")
		}
		if (hydrated?.interaction?.status === "awaiting") {
			const view = projectTaskView(hydrated)
			const interaction = view.activeInteraction
			const anchor = interaction ? await reader.getByTimestamp(interaction.askMessageTs) : undefined
			if (interaction) {
				if (anchor && matchesActiveInteractionAnchor(anchor, interaction)) {
					return {
						messages: durableMessages,
						view: {
							...view,
							activeInteraction: {
								...interaction,
								anchorVerified: this.hasMatchingAnchor(durableMessages, interaction),
							},
						},
					}
				}
				return { messages: durableMessages, view: projectMissingInteractionAnchor(view) }
			}
		}

		return this.projectSyntheticInteraction(
			durableMessages,
			snapshot?.phase === TaskPhase.COMPLETED ? "completion" : "resume",
		)
	}

	private tryHydrate(snapshot: TaskSnapshot | undefined): TaskRuntimeState | undefined {
		if (!snapshot) return undefined
		try {
			normalizeStoppedTaskSnapshot(snapshot)
			return hydrateSnapshot(snapshot)
		} catch {
			return undefined
		}
	}

	private hasMatchingAnchor(
		messages: readonly ClineMessage[],
		interaction: NonNullable<TaskViewState["activeInteraction"]>,
	): boolean {
		return messages.filter((message) => matchesActiveInteractionAnchor(message, interaction)).length === 1
	}

	private projectSyntheticInteraction(
		durableMessages: ClineMessage[],
		kind: "resume" | "completion",
	): { messages: ClineMessage[]; view: TaskViewState; syntheticMessage: ClineMessage } {
		const definition = getInteraction(kind)
		const revision = 0
		const turnId = `history-display:${this.taskId}`
		const interactionId = `${turnId}:${kind}`
		const messageTs = durableMessages.reduce((latest, message) => Math.max(latest, message.ts), 0) + 1
		const taskAsk = kind === "completion" ? "resume_completed_task" : definition.taskAsk
		const interaction: ActiveInteraction = {
			taskId: this.taskId,
			turnId,
			interactionId,
			kind,
			status: "awaiting",
			createdRevision: revision,
			anchor: { messageTs, messageType: "ask", taskAsk },
		}
		const state: TaskRuntimeState = {
			taskId: this.taskId,
			phase: kind === "completion" ? TaskPhase.COMPLETED : TaskPhase.PAUSED,
			revision,
			anchor: { apiIndex: -1, uiMessageTs: messageTs, turnId, interactionId },
			interaction,
			...(kind === "completion" ? { completion: { completionId: `history-display:${this.taskId}:completion` } } : {}),
		}
		const syntheticAsk: ClineMessage = {
			ts: messageTs,
			type: "ask",
			ask: taskAsk,
			text: "",
			partial: false,
			interactionId,
		}
		const view = projectTaskView(state)
		return {
			messages: [...durableMessages, syntheticAsk],
			view: view.activeInteraction
				? { ...view, activeInteraction: { ...view.activeInteraction, anchorVerified: true } }
				: view,
			syntheticMessage: syntheticAsk,
		}
	}
}
