import { Logger } from "@/shared/services/Logger"

/**
 * Whether a Dline view (the sidebar or an editor panel) has been shown in this window.
 *
 * Dline starts with VS Code, long before the user opens it. Work that has to ask the
 * user something, such as a missing MCP variable, waits for this so that starting
 * VS Code never opens Dline input boxes the user did not ask for.
 */
export class DlineUiPresence {
    private shown = false
    private readonly listeners = new Set<() => void>()

    get isShown(): boolean {
        return this.shown
    }

    /** Called by the host when a Dline view becomes visible; only the first call has an effect. */
    markShown(): void {
        if (this.shown) return
        this.shown = true
        const listeners = [...this.listeners]
        this.listeners.clear()
        for (const listener of listeners) {
            try {
                listener()
            } catch (error) {
                Logger.error("[DlineUiPresence] Listener failed:", error)
            }
        }
    }

    /** Run once when a Dline view is first shown, or right away if one already was. Returns an unsubscribe. */
    onFirstShown(listener: () => void): () => void {
        if (this.shown) {
            listener()
            return () => {}
        }
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }
}

/** The presence of this window's Dline views. */
export const dlineUiPresence = new DlineUiPresence()
