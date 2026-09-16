import { type ClineAsk, type ClineMessage, type ClineSay } from "@shared/ExtensionMessage"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import type { ClineMessageModelInfo } from "@/shared/messages"
import type { MessageStateHandler } from "./message-state"
import type { TaskState } from "./TaskState"

const ABORT_ALLOWED_SAY_TYPES = new Set<ClineSay>(["hook_status", "hook_output_stream", "deleted_api_reqs", "state_snapshot"])

/**
 * Check whether a say message is required for abort-time lifecycle cleanup.
 *
 * @param type Say message type being emitted.
 * @returns True when the message may be persisted after task abort.
 */
export function isAbortAllowedSay(type: ClineSay): boolean {
	return ABORT_ALLOWED_SAY_TYPES.has(type)
}

// ── Types ──

export interface AskOptions {
	onAskVisible?: (askTs: number) => Promise<void> | void
	existingTs?: number
	onTsCreated?: (ts: number) => void
	commandTs?: number
}

export interface AskResult {
	response: ClineAskResponse
	text?: string
	images?: string[]
	files?: string[]
	askTs?: number
}

/**
 * A point in an ask's life that has to be recoverable from a log.
 *
 * A stranded ask leaves no trace of its own: the wait is silent and the task
 * simply stops progressing. Naming the transitions is what separates an ask
 * still waiting for a user from one whose answer never reached it.
 *
 * - `window_open`: the channel began accepting a response for this ask.
 * - `ui_presented`: the question reached the webview and can be answered.
 * - `response_received`: the wait ended with an answer.
 * - `abandoned`: the wait ended without one, superseded or aborted.
 */
export type AskLifecycleEvent = "window_open" | "ui_presented" | "response_received" | "abandoned"

export interface AskLifecycleRecord {
	event: AskLifecycleEvent
	ask: ClineAsk
	askTs: number
	/** Milliseconds since the receive window opened; absent before it opens. */
	elapsedMs?: number
	/** Set on `abandoned` to say which exit was taken. */
	reason?: "superseded" | "aborted"
}

export interface MessageChannelConfig {
	pushMessage: (msg: ClineMessage) => void | Promise<void>
	syncState: () => Promise<void>
	messageStateHandler: MessageStateHandler
	taskState: TaskState
	getProviderInfo: () => ClineMessageModelInfo
	genTs: () => number
	/**
	 * Reports ask lifecycle transitions. Optional so the channel keeps working
	 * without a diagnostics sink, and injected rather than imported so the
	 * channel stays free of logging dependencies and stays assertable.
	 */
	recordAskLifecycle?: (record: AskLifecycleRecord) => void
}

// ── MessageChannel ──

/**
 * Standalone message engine extracted from Task.say/ask.
 * Handles message formatting, persistence (memory + jsonl),
 * gRPC push via injected callbacks, and ask response waiting.
 *
 * Does NOT depend on Task or Controller — only on injected config.
 */
export class MessageChannel {
	private pushMessage: (msg: ClineMessage) => void | Promise<void>
	private syncState: () => Promise<void>
	private messageStateHandler: MessageStateHandler
	private taskState: TaskState
	private getProviderInfo: () => ClineMessageModelInfo
	private genTs: () => number
	private recordAskLifecycle?: (record: AskLifecycleRecord) => void
	/**
	 * Whether an `ask()` call is currently waiting for a response.
	 *
	 * `resolve()` only parks its argument in `taskState`, so a response that
	 * arrives while nothing is waiting is not discarded: it sits there until
	 * the *next* unrelated `ask()` consumes it as if it were the answer. The
	 * user's text then enters the conversation as a reply to a question they
	 * never saw. This flag lets `resolve()` recognize and refuse that case.
	 */
	private isAwaitingAskResponse = false

	constructor(config: MessageChannelConfig) {
		this.pushMessage = config.pushMessage
		this.syncState = config.syncState
		this.messageStateHandler = config.messageStateHandler
		this.taskState = config.taskState
		this.getProviderInfo = config.getProviderInfo
		this.genTs = config.genTs
		this.recordAskLifecycle = config.recordAskLifecycle
	}

	// ── Helpers ──

	private async postStateToWebview(): Promise<void> {
		await this.syncState()
	}

	private shouldMessageInvalidateAsk(message: ClineMessage): boolean {
		if (message.type === "say" && message.say === "state_snapshot") {
			return false
		}

		if (message.type === "say" && message.say === "user_feedback" && this.taskState.askResponse !== undefined) {
			return false
		}

		return true
	}

	private isAskPromiseSuperseded(invalidationStartIndex: number): boolean {
		const messages = this.messageStateHandler.clineMessages
		for (let i = invalidationStartIndex; i < messages.length; i++) {
			if (this.shouldMessageInvalidateAsk(messages[i])) {
				return true
			}
		}
		return false
	}

	// ── say ──

	/**
	 * Add or update a "say" message in the chat.
	 * Signature matches Task.say exactly.
	 */
	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		existingTs?: number,
		commandTs?: number,
	): Promise<number | undefined> {
		// Allow lifecycle messages during abort so cancel/resume state can be persisted.
		if (this.taskState.abort && !isAbortAllowedSay(type)) {
			throw new Error("Dline instance aborted")
		}

		const modelInfo = this.getProviderInfo()

		// partial === true: update the memory layer and defer the durable flush.
		if (partial === true) {
			const ts = existingTs ?? this.genTs()
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const msg = { ts, type: "say" as const, say: type, text, images, files, partial: true, modelInfo, commandTs }
			const upserted = await this.messageStateHandler.upsertClineMessageInMemory(msg)
			this.pushMessage(upserted)
			this.taskState.lastMessageTs = ts
			return ts
		}

		// partial === false: finalize — same ts replace memory → persist jsonl
		if (partial === false) {
			const ts = existingTs ?? this.genTs()
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const msg: any = { ts, type: "say", say: type, text, images, files, modelInfo, commandTs }
			// Preserve commandStatus for command messages
			if (type === "command") {
				const existing = existingTs ? this.messageStateHandler.clineMessages.find((m) => m.ts === existingTs) : undefined
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const existingStatus = (existing as ClineMessage)?.commandStatus
				msg.commandStatus = existingStatus || "pending"
			}
			const finalized = await this.messageStateHandler.finalizeClineMessage(msg)
			await this.pushMessage(finalized)
			await this.postStateToWebview()
			this.taskState.lastMessageTs = ts
			return ts
		}

		// partial === undefined: normal message, add + persist + postState
		const ts = this.genTs()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const msg: any = { ts, type: "say", say: type, text, images, files, modelInfo, commandTs }
		if (type === "command") {
			msg.commandStatus = "pending"
		}
		await this.messageStateHandler.addToClineMessages(msg)
		await this.postStateToWebview()
		this.pushMessage(msg)
		this.taskState.lastMessageTs = ts
		return ts
	}

	// ── ask ──

	/** Persist one ask presentation without creating a legacy response waiter. */
	/** Persist one causally identified say row exactly once. */
	async presentSay(
		type: ClineSay,
		text: string | undefined,
		images: string[] | undefined,
		files: string[] | undefined,
		interactionId: string,
		userInputKind?: ClineMessage["userInputKind"],
		queuedInputMode?: ClineMessage["queuedInputMode"],
	): Promise<number> {
		const messages = this.messageStateHandler.clineMessages
		const matches = messages
			.map((message, index) => ({ message, index }))
			.filter(({ message }) => message.type === "say" && message.say === type && message.interactionId === interactionId)
		if (matches.length > 1) {
			throw new Error(`Duplicate causal say rows for interactionId=${interactionId}`)
		}

		const existing = matches[0]
		const ts = existing?.message.ts ?? this.genTs()
		const message = {
			type: "say" as const,
			say: type,
			text,
			images,
			files,
			partial: false,
			interactionId,
			// Only carried for input that came from the queue. Writing the keys
			// unconditionally would put `undefined` on every ordinary message and
			// change the shape that is persisted and compared.
			...(userInputKind ? { userInputKind } : {}),
			...(queuedInputMode ? { queuedInputMode } : {}),
			modelInfo: this.getProviderInfo(),
		}
		if (existing) {
			await this.messageStateHandler.updateClineMessage(existing.index, message)
			await this.messageStateHandler.flushMessageUpdate(existing.index)
		} else {
			await this.messageStateHandler.addToClineMessages({ ts, ...message })
			await this.messageStateHandler.flushUiMessages()
		}

		this.taskState.lastMessageTs = ts
		await this.postStateToWebview()
		const persisted = this.messageStateHandler.clineMessages.find(
			(candidate) => candidate.ts === ts && candidate.interactionId === interactionId,
		)
		if (!persisted) throw new Error(`Causal say row disappeared for interactionId=${interactionId}`)
		this.pushMessage(persisted)
		return ts
	}

	async presentAsk(type: ClineAsk, text?: string, existingTs?: number, interactionId?: string): Promise<number> {
		const askTs = existingTs ?? this.genTs()
		this.taskState.lastMessageTs = askTs
		const messages = this.messageStateHandler.clineMessages
		const index = messages.findIndex((message) => message.ts === askTs)
		const existing = index >= 0 ? messages[index] : undefined
		const commandPresentation = type === "command" ? { commandStatus: "pending" as const, exitCode: undefined } : {}
		const interactionIdentity = interactionId ? { interactionId } : {}
		const askMessage = {
			ts: askTs,
			type: "ask" as const,
			say: undefined,
			ask: type,
			text,
			partial: false,
			...interactionIdentity,
			...commandPresentation,
		}
		if (existing?.partial === true) {
			await this.messageStateHandler.finalizeClineMessage({ ...existing, ...askMessage })
		} else if (index >= 0) {
			await this.messageStateHandler.updateClineMessage(index, askMessage)
			await this.messageStateHandler.flushMessageUpdate(index)
		} else {
			await this.messageStateHandler.addToClineMessages(askMessage)
		}
		await this.messageStateHandler.flushUiMessages()
		await this.postStateToWebview()
		const persisted = this.messageStateHandler.clineMessages.find((message) => message.ts === askTs)
		if (persisted) {
			await this.pushMessage(persisted)
		}
		return askTs
	}

	/**
	 * Send an "ask" message and wait for user response.
	 * Signature matches Task.ask exactly.
	 */
	async ask(type: ClineAsk, text?: string, partial?: boolean, options?: AskOptions): Promise<AskResult> {
		// Allow resume asks even when aborted
		if (this.taskState.abort && type !== "resume_task" && type !== "resume_completed_task") {
			throw new Error("Dline instance aborted")
		}

		// Set when the receive window opens, so every later record can report
		// how long this ask has been waiting rather than only that it is.
		let windowOpenedAt: number | undefined
		const reportLifecycle = (event: AskLifecycleEvent, askTs: number, reason?: AskLifecycleRecord["reason"]): void => {
			this.recordAskLifecycle?.({
				event,
				ask: type,
				askTs,
				elapsedMs: windowOpenedAt === undefined ? undefined : Math.round(performance.now() - windowOpenedAt),
				reason,
			})
		}

		let didNotifyAskVisible = false
		const notifyAskVisible = async (askTs: number) => {
			if (!options?.onAskVisible || didNotifyAskVisible) {
				return
			}
			didNotifyAskVisible = true
			await options.onAskVisible(askTs)
		}

		let invalidationStartIndex = 0
		const askTs = options?.existingTs ?? this.genTs()
		if (partial !== undefined) {
			if (partial) {
				const upserted = await this.messageStateHandler.upsertClineMessageInMemory({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
					partial: true,
					commandTs: options?.commandTs,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as Partial<ClineMessage>)
				this.pushMessage(upserted)
				this.taskState.lastMessageTs = askTs
				options?.onTsCreated?.(askTs)
				await notifyAskVisible(askTs)
				throw new Error("Current ask promise was ignored")
			}

			// partial=false: finalize
			this.taskState.lastMessageTs = askTs
			this.openAskReceiveWindow()
			windowOpenedAt = performance.now()
			reportLifecycle("window_open", askTs)
			const finalized = await this.messageStateHandler.finalizeClineMessage({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
				commandTs: options?.commandTs,
				commandStatus: type === "command" ? "pending" : undefined,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as Partial<ClineMessage>)
			this.pushMessage(finalized)
			await this.postStateToWebview()
			options?.onTsCreated?.(askTs)
			await notifyAskVisible(askTs)
			reportLifecycle("ui_presented", askTs)
			invalidationStartIndex = this.messageStateHandler.clineMessages.length
		} else {
			// Non-partial ask
			this.taskState.lastMessageTs = askTs
			this.openAskReceiveWindow()
			windowOpenedAt = performance.now()
			reportLifecycle("window_open", askTs)
			if (options?.existingTs !== undefined) {
				const msgs = this.messageStateHandler.clineMessages
				const idx = msgs.findIndex((m) => m.ts === options?.existingTs)
				if (idx !== -1) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const updates: Partial<ClineMessage> = { partial: false }
					if (type === "command") {
						updates.commandStatus = "pending"
						updates.exitCode = undefined
					}
					if (text !== undefined) {
						updates.text = text
					}
					await this.messageStateHandler.updateClineMessage(idx, updates)
				} else {
					await this.messageStateHandler.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						partial: false,
						commandTs: options?.commandTs,
						commandStatus: type === "command" ? "pending" : undefined,
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
					} as Partial<ClineMessage>)
				}
			} else {
				await this.messageStateHandler.addToClineMessages({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
					commandTs: options?.commandTs,
					commandStatus: type === "command" ? "pending" : undefined,
				})
			}
			await this.postStateToWebview()
			const msgs = this.messageStateHandler.clineMessages
			this.pushMessage(msgs[msgs.length - 1])
			await notifyAskVisible(askTs)
			reportLifecycle("ui_presented", askTs)
			invalidationStartIndex = this.messageStateHandler.clineMessages.length
		}

		// The receive window was opened before this ask became visible, so the
		// response state must not be cleared here. A response captured in the
		// meantime is a legitimate answer to this very ask, and discarding it
		// would leave this wait with nothing left to wake it.

		// Notification hook handled by Task.ask() wrapper

		// Wait for response
		const shouldWakeOnAbort = type !== "resume_task" && type !== "resume_completed_task"
		try {
			await pWaitFor(
				() =>
					this.taskState.askResponse !== undefined ||
					this.isAskPromiseSuperseded(invalidationStartIndex) ||
					(shouldWakeOnAbort && this.taskState.abort),
				{ interval: 100 },
			)
		} finally {
			// Cleared on every exit, including the throws below: an abandoned
			// ask must not leave the channel accepting responses for a question
			// that is no longer being asked.
			this.isAwaitingAskResponse = false
		}
		if (shouldWakeOnAbort && this.taskState.abort && this.taskState.askResponse === undefined) {
			reportLifecycle("abandoned", askTs, "aborted")
			throw new Error("Dline instance aborted")
		}
		if (this.taskState.askResponse === undefined && this.isAskPromiseSuperseded(invalidationStartIndex)) {
			reportLifecycle("abandoned", askTs, "superseded")
			throw new Error("Current ask promise was ignored")
		}
		reportLifecycle("response_received", askTs)

		const result: AskResult = {
			response: this.taskState.askResponse!,
			text: this.taskState.askResponseText,
			images: this.taskState.askResponseImages,
			files: this.taskState.askResponseFiles,
		}
		this.taskState.askResponse = undefined
		this.taskState.askResponseText = undefined
		this.taskState.askResponseImages = undefined
		this.taskState.askResponseFiles = undefined
		return result
	}

	// ── resolve ──

	/**
	 * Open the window during which a user response belongs to the ask that is
	 * about to be presented.
	 *
	 * This must run before any await that can make the ask visible. The user can
	 * answer as soon as the question reaches the screen, and a response arriving
	 * while the window is still closed is refused by {@link resolve} and lost —
	 * leaving the ask waiting for an answer that is never repeated.
	 *
	 * Clearing the previous response and opening the window stay in one
	 * synchronous block on purpose: an await between them would discard a
	 * response that had already been captured for this ask.
	 */
	private openAskReceiveWindow(): void {
		this.taskState.askResponse = undefined
		this.taskState.askResponseText = undefined
		this.taskState.askResponseImages = undefined
		this.taskState.askResponseFiles = undefined
		this.isAwaitingAskResponse = true
	}

	/**
	 * Resolve a pending ask with the webview's response.
	 * Called by handleWebviewAskResponse → this resolves the Promise in ask().
	 *
	 * A response that arrives while no ask is waiting is refused rather than
	 * stored. Storing it would let it be consumed by whatever question is asked
	 * next, turning the user's input into an answer to something else.
	 *
	 * @returns Whether the response was accepted by a waiting ask.
	 */
	resolve(response: ClineAskResponse, text?: string, images?: string[], files?: string[]): boolean {
		if (!this.isAwaitingAskResponse) {
			return false
		}
		this.taskState.askResponse = response
		this.taskState.askResponseText = text
		this.taskState.askResponseImages = images
		this.taskState.askResponseFiles = files
		return true
	}
}
