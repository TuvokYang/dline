/** How long activity IO waits for the Webview to ask for the first message window. */
export const HISTORY_ACTIVITY_FALLBACK_MS = 2_000

/**
 * Holds a history display's activity IO back until its first message window is out.
 *
 * `activities.db` is read and written synchronously on the extension host, and
 * a long task's activities take hundreds of milliseconds to hydrate and recover.
 * Started as soon as the surface is published, that work queues the Webview's
 * first message-window request behind it. Nothing the first frame draws
 * depends on activities, so they wait for that window, or for a bounded
 * fallback when the Webview never asks for one.
 */
export class HistoryActivityGate {
	private opened = false
	private fallback?: ReturnType<typeof setTimeout>
	private release!: () => void
	private readonly whenOpened = new Promise<void>((resolve) => {
		this.release = resolve
	})

	constructor(private readonly fallbackMs = HISTORY_ACTIVITY_FALLBACK_MS) {}

	/** Resolves once activity IO may run. */
	whenOpen(): Promise<void> {
		return this.whenOpened
	}

	/** The surface was published: open after the fallback unless a window is served first. */
	armFallback(): void {
		if (this.opened || this.fallback) return
		this.fallback = setTimeout(() => this.open(), this.fallbackMs)
	}

	/**
	 * A message window was read for the Webview. Its RPC response is posted in
	 * the continuation of the current turn, so the gate opens on the next one.
	 */
	openAfterServing(): void {
		if (this.opened) return
		setImmediate(() => this.open())
	}

	open(): void {
		if (this.opened) return
		this.opened = true
		clearTimeout(this.fallback)
		this.fallback = undefined
		this.release()
	}
}
