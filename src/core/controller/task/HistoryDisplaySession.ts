import path from "node:path"
import type { ClineMessage, TaskViewState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { ensureTaskDirectoryExists } from "@/core/storage/disk"
import { UIMessage } from "@/core/storage/UIMessage"
import type { UIMessageWindowPage, UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"
import { getInteraction } from "@/core/task/interaction/InteractionRegistry"
import type { TaskState } from "@/core/task/kernel"
import { FileTaskStateVault } from "@/core/task/stores"
import { TaskPhase } from "@/core/task/TaskPhase"
import { projectCanonicalTaskView } from "@/core/task/view/canonical/projectCanonicalTaskView"
import {
	type HistoryDisplayInteractionKind,
	projectHistoryDisplayState,
} from "@/core/task/view/canonical/projectHistoryDisplayState"
import { projectHistoryPreparingView } from "./history-task-readiness"
import { adaptCanonicalTaskView } from "./TaskViewMessageAdapter"

/**
 * Lightweight owner for a historical surface before the user resumes execution.
 *
 * It deliberately owns only the UI history needed to render the panel and a
 * snapshot-derived interaction projection. API history, Task runtime services,
 * locks, terminals, browser sessions, and orchestrator registration are created
 * only when the user dispatches an action and the Controller promotes the
 * session into a real Task.
 */
const HISTORY_MESSAGE_WINDOW_SIZE = 200

export class HistoryDisplaySession {
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
			])
			if (this.disposed) return

			const projected = this.projectSnapshot(snapshot, durableMessages)
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
		const reader = this.messageReader
		this.messageReader = undefined
		this.messages = []
		this.syntheticMessage = undefined
		this.taskTitleMessage = undefined
		this.durableMessageCount = 0
		if (reader) await reader.close()
	}

	private async readSnapshot(): Promise<TaskState | undefined> {
		try {
			const runtimeDirectory = path.join(await ensureTaskDirectoryExists(this.taskId), "runtime-v2")
			return (await new FileTaskStateVault(runtimeDirectory).load(this.taskId))?.state
		} catch {
			return undefined
		}
	}

	/**
	 * Render the stopped task from its durable state. A snapshot that never
	 * reached an interaction still owes the user a way back in, so the display
	 * projection synthesizes one and this method supplies its anchor row.
	 */
	private projectSnapshot(
		snapshot: TaskState | undefined,
		durableMessages: ClineMessage[],
	): { messages: ClineMessage[]; view: TaskViewState; syntheticMessage?: ClineMessage } {
		const display = projectHistoryDisplayState(this.taskId, snapshot)
		if (!display.synthetic) {
			return { messages: durableMessages, view: this.projectView(display.state, durableMessages) }
		}
		const syntheticMessage: ClineMessage = {
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

	private projectView(state: TaskState, messages: readonly ClineMessage[]): TaskViewState {
		return adaptCanonicalTaskView(projectCanonicalTaskView(state), messages)
	}
}

/** A completed task reopened from history asks to resume rather than replaying its completion row. */
function historyDisplayTaskAsk(kind: HistoryDisplayInteractionKind): ClineMessage["ask"] {
	return kind === "completion" ? "resume_completed_task" : getInteraction(kind).taskAsk
}
