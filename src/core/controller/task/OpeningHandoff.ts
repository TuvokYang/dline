/**
 * Holds state publications while one opening of a task replaces another.
 *
 * Replacing an opening of the same task, such as promoting a history display
 * into its runtime, tears the old opening down before the new one is
 * installed, so for that span no opening exists. A state built then shows the
 * task as closed, and the Webview resets what it keys by task, such as the
 * Activities tab the promoting Retry was pressed in. A publication requested
 * in that span is held and published once, after the handoff settles.
 */
export class OpeningHandoff {
    private active = false
    private held = false

    /**
     * Whether a publication must not go out now. Ask before building state and
     * again before delivering it, since an opening can go away during the
     * build. A held publication is not lost: the handoff publishes once when it
     * settles.
     */
    holds(hasOpening: boolean): boolean {
        if (!this.active || hasOpening) return false
        this.held = true
        return true
    }

    /**
     * Run `handoff`, then publish once when a publication was held meanwhile or
     * when the handoff failed: a failure leaves the old opening torn down, and
     * the Webview must learn that even if nothing asked to publish. A failed
     * handoff rejects with its own error, never with the publication's.
     */
    async run(handoff: () => Promise<void>, publish: () => Promise<void>): Promise<void> {
        this.active = true
        let failure: { error: unknown } | undefined
        try {
            await handoff()
        } catch (error) {
            failure = { error }
        }
        this.active = false
        const mustPublish = this.held || failure !== undefined
        this.held = false
        if (mustPublish) {
            try {
                await publish()
            } catch (publishError) {
                if (!failure) throw publishError
            }
        }
        if (failure) throw failure.error
    }
}
