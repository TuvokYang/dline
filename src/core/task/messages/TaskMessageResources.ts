import type { ClineMessage } from "@shared/ExtensionMessage"
import {
	ApiConversation,
	type ApiConversationReadWindow,
	type ApiConversationWindowOptions,
} from "@/core/storage/ApiConversation"
import { UIMessage } from "@/core/storage/UIMessage"
import type { UIMessageRecoveryBoundary, UIMessageWindowPage, UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"

const DISPLAY_WINDOW_SIZE = 200

export interface TaskExecutionMessages {
	readonly uiMessage: UIMessage
	readonly apiConversation: ApiConversation
}

export interface TaskMessageResourcePorts {
	openWindow(taskId: string): Promise<UIMessageWindowReader>
	openUiMessages(taskId: string): Promise<UIMessage>
	openApiConversation(taskId: string): Promise<ApiConversation>
	persistHistoricalMessage(taskId: string, message: ClineMessage): Promise<ClineMessage>
}

const DEFAULT_PORTS: TaskMessageResourcePorts = {
	openWindow: (taskId) => UIMessage.openWindow(taskId, { readOnly: true }),
	openUiMessages: (taskId) => UIMessage.open(taskId),
	openApiConversation: (taskId) => ApiConversation.open(taskId),
	persistHistoricalMessage: (taskId, message) => UIMessage.persistHistoricalMessage(taskId, message),
}

/**
 * Task-owned message IO. A display window and execution stores are resource
 * modes of the same Task, not separate runtime, interaction or view owners.
 */
export class TaskMessageResources {
	private window?: UIMessageWindowReader
	private displayOpening?: Promise<void>
	private executionOpening?: Promise<TaskExecutionMessages>
	private execution?: TaskExecutionMessages
	private recoveryApiWindow?: ApiConversationReadWindow
	private latestMessages: ClineMessage[] = []
	private latestWindowStart?: number
	private titleMessage?: ClineMessage
	private readonly appendedMessages: ClineMessage[] = []
	private readonly replacedMessages = new Map<number, ClineMessage>()
	private persistence: Promise<unknown> = Promise.resolve()
	private readonly reads = new Set<Promise<unknown>>()
	private closing = false
	private closePromise?: Promise<void>

	constructor(
		private readonly taskId: string,
		execution?: TaskExecutionMessages,
		private readonly ports: TaskMessageResourcePorts = DEFAULT_PORTS,
	) {
		this.execution = execution
	}

	get hasExecutionStores(): boolean {
		return this.execution !== undefined
	}

	getMessageCount(): number {
		return this.execution?.uiMessage.count ?? (this.window?.count ?? 0) + this.appendedMessages.length
	}

	getDisplayMessages(): readonly ClineMessage[] {
		if (this.execution) return this.execution.uiMessage.getAll()
		return [
			...this.latestMessages.map((message) => this.replacedMessages.get(message.ts) ?? message),
			...this.appendedMessages,
		]
	}

	getTitleMessage(): ClineMessage | undefined {
		if (this.execution) return this.execution.uiMessage.getAt(0)
		return this.titleMessage ? (this.replacedMessages.get(this.titleMessage.ts) ?? this.titleMessage) : undefined
	}

	openDisplay(): Promise<void> {
		if (this.closing) return Promise.reject(new Error("Task message resources are closed"))
		if (this.execution) return Promise.resolve()
		if (!this.displayOpening) {
			const opening = this.loadDisplayWindow().catch((error) => {
				if (this.displayOpening === opening) this.displayOpening = undefined
				throw error
			})
			this.displayOpening = opening
		}
		return this.displayOpening
	}

	fetchMessages(referenceIndex: number, count: number): Promise<UIMessageWindowPage> {
		return this.read(async () => {
			await this.openDisplay()
			this.assertOpen()
			const execution = this.execution
			if (!execution) {
				const window = this.window
				if (!window) throw new Error("Task display window is unavailable")
				const totalCount = this.getMessageCount()
				const size = Math.max(0, Math.trunc(count))
				const startIndex =
					referenceIndex === -1
						? Math.max(0, totalCount - size)
						: Math.max(0, Math.min(Math.trunc(referenceIndex), totalCount))
				const endIndex = Math.min(startIndex + size, totalCount)
				const durableCount = Math.max(0, Math.min(endIndex, window.count) - startIndex)
				const base = await this.readDisplayPage(window, startIndex, durableCount)
				return {
					messages: [
						...base.map((message) => this.replacedMessages.get(message.ts) ?? message),
						...this.appendedMessages.slice(
							Math.max(0, startIndex - window.count),
							Math.max(0, endIndex - window.count),
						),
					],
					totalCount,
					startIndex,
				}
			}
			const messages = execution.uiMessage.getAll()
			const totalCount = messages.length
			const size = Math.max(0, Math.trunc(count))
			const startIndex =
				referenceIndex === -1
					? Math.max(0, totalCount - size)
					: Math.max(0, Math.min(Math.trunc(referenceIndex), totalCount))
			return { messages: messages.slice(startIndex, startIndex + size), totalCount, startIndex }
		})
	}

	getMessageByTimestamp(timestamp: number): Promise<ClineMessage | undefined> {
		return this.read(async () => {
			await this.openDisplay()
			this.assertOpen()
			return this.execution
				? this.execution.uiMessage.getByTs(timestamp)
				: (this.replacedMessages.get(timestamp) ??
						this.appendedMessages.find((message) => message.ts === timestamp) ??
						(await this.window?.getByTimestamp(timestamp)))
		})
	}

	readApiWindow(options: ApiConversationWindowOptions) {
		return this.read(async () => {
			const window = await ApiConversation.readWindow(this.taskId, options)
			this.recoveryApiWindow = window
			return window
		})
	}

	getApiMessageAt(index: number) {
		return this.execution?.apiConversation.getAt(index) ?? this.recoveryApiWindow?.getAt(index)
	}

	/** Supply exact stopped-state recovery records, not an alternate runtime projection. */
	readRecoveryMessages(boundary?: UIMessageRecoveryBoundary): Promise<ClineMessage[]> {
		return this.read(async () => {
			await this.openDisplay()
			this.assertOpen()
			if (this.execution) return [...this.execution.uiMessage.getAll()]
			const window = this.window
			if (!window) throw new Error("Task display window is unavailable")
			const base = boundary ? await window.getRecoveryMessages(boundary) : (await window.getPage(0, window.count)).messages
			return [...base.map((message) => this.replacedMessages.get(message.ts) ?? message), ...this.appendedMessages]
		})
	}

	/** Persist a real canonical row while retaining the bounded display cache. */
	persistMessage(message: ClineMessage): Promise<ClineMessage> {
		const predecessor = this.persistence
		const persistence = this.read(async () => {
			await predecessor.catch(() => undefined)
			await this.openDisplay()
			this.assertOpen()
			if (this.execution) {
				const index = this.execution.uiMessage.findIndexByTs(message.ts)
				if (index < 0) return await this.execution.uiMessage.appendDurable(message)
				const stored = await this.execution.uiMessage.updateMessage(index, message)
				await this.execution.uiMessage.flush()
				return stored
			}
			const appendedIndex = this.appendedMessages.findIndex((row) => row.ts === message.ts)
			const previous = this.replacedMessages.get(message.ts) ?? (await this.window?.getByTimestamp(message.ts))
			const stored = await this.ports.persistHistoricalMessage(this.taskId, message)
			if (appendedIndex >= 0) this.appendedMessages[appendedIndex] = stored
			else if (previous) this.replacedMessages.set(message.ts, stored)
			else this.appendedMessages.push(stored)
			return stored
		})
		this.persistence = persistence
		return persistence
	}

	/** Materialize writable histories only after explicit execution admission. */
	openExecution(): Promise<TaskExecutionMessages> {
		if (this.closing) return Promise.reject(new Error("Task message resources are closed"))
		if (this.execution) return Promise.resolve(this.execution)
		if (!this.executionOpening) {
			const opening = this.loadExecutionStores([...this.reads]).catch((error) => {
				if (this.executionOpening === opening) this.executionOpening = undefined
				throw error
			})
			this.executionOpening = opening
		}
		return this.executionOpening
	}

	/** Fence immediately, then drain admitted IO and close only acquired resources. */
	close(): Promise<void> {
		this.closing = true
		this.closePromise ??= (async () => {
			await Promise.allSettled([this.displayOpening, this.executionOpening])
			await Promise.allSettled([...this.reads])
			const window = this.window
			const execution = this.execution
			this.window = undefined
			this.execution = undefined
			this.recoveryApiWindow = undefined
			this.latestMessages = []
			this.latestWindowStart = undefined
			this.titleMessage = undefined
			this.appendedMessages.length = 0
			this.replacedMessages.clear()
			const results = await Promise.allSettled([
				window?.close(),
				execution?.uiMessage.close(),
				execution?.apiConversation.close(),
			])
			const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
			if (failure) throw failure.reason
		})()
		return this.closePromise
	}

	private async readDisplayPage(window: UIMessageWindowReader, startIndex: number, count: number): Promise<ClineMessage[]> {
		if (count === 0) return []
		const cachedStart = this.latestWindowStart
		if (
			cachedStart !== undefined &&
			startIndex >= cachedStart &&
			startIndex + count <= cachedStart + this.latestMessages.length
		) {
			return this.latestMessages.slice(startIndex - cachedStart, startIndex - cachedStart + count)
		}
		return (await window.getPage(startIndex, count)).messages
	}

	private async loadDisplayWindow(): Promise<void> {
		const window = await this.ports.openWindow(this.taskId)
		try {
			this.assertOpen()
			const [latest, first] = await Promise.all([window.getLatest(DISPLAY_WINDOW_SIZE), window.getPage(0, 1)])
			this.assertOpen()
			this.latestMessages = latest
			// A reader may skip malformed rows; only a complete tail has reliable offsets.
			const expectedSize = Math.min(DISPLAY_WINDOW_SIZE, window.count)
			this.latestWindowStart = latest.length === expectedSize ? window.count - expectedSize : undefined
			this.titleMessage = first.messages[0]
			this.window = window
		} catch (error) {
			await window.close()
			throw error
		}
	}

	private async loadExecutionStores(admittedReads: readonly Promise<unknown>[]): Promise<TaskExecutionMessages> {
		let uiMessage: UIMessage | undefined
		let apiConversation: ApiConversation | undefined
		try {
			await this.displayOpening
			await Promise.allSettled(admittedReads)
			this.assertOpen()
			// Windows does not allow an atomic rename over a file while the bounded
			// history reader still owns a read handle. Retire that handle before the
			// writable store runs any compatibility normalization.
			await this.retireDisplayWindowForExecution()
			this.assertOpen()
			uiMessage = await this.ports.openUiMessages(this.taskId)
			this.assertOpen()
			apiConversation = await this.ports.openApiConversation(this.taskId)
			this.assertOpen()
			const execution = { uiMessage, apiConversation }
			this.execution = execution
			this.recoveryApiWindow = undefined
			// Reads issued during admission wait on executionOpening and cannot
			// race the full-store load after the display handle is retired.
			this.latestMessages = []
			this.latestWindowStart = undefined
			this.titleMessage = undefined
			this.appendedMessages.length = 0
			this.replacedMessages.clear()
			return execution
		} catch (error) {
			if (this.execution?.uiMessage === uiMessage) this.execution = undefined
			await Promise.allSettled([uiMessage?.close(), apiConversation?.close()])
			throw error
		}
	}

	private async retireDisplayWindowForExecution(): Promise<void> {
		const window = this.window
		if (window) await window.close()
		if (this.window === window) this.window = undefined
		// A failed execution admission can reopen a fresh display window; keeping
		// the resolved opening promise would otherwise claim that the closed reader
		// is still available.
		this.displayOpening = undefined
	}

	private read<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new Error("Task message resources are closed"))
		const read = this.executionOpening ? this.executionOpening.then(operation) : operation()
		this.reads.add(read)
		void read.then(
			() => this.reads.delete(read),
			() => this.reads.delete(read),
		)
		return read
	}

	private assertOpen(): void {
		if (this.closing) throw new Error("Task message resources are closed")
	}
}
