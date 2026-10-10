/**
 * Presentation policy for the streaming "thinking" indicator.
 *
 * Providers expose reasoning in two shapes:
 *  - plain text reasoning, which can be rendered verbatim;
 *  - opaque encrypted reasoning (carried as `redacted_thinking` blocks), whose
 *    payload must never be shown but still means the model is actively working.
 *
 * Both shapes drive the same UI row. This module owns the decision of when that
 * row opens, when it is promoted to real text, and when an indicator that never
 * received text has to be withdrawn, so the streaming loop only executes the
 * resulting action.
 */

/** Observable stream facts required to decide the next indicator action. */
export interface ReasoningIndicatorSignals {
    /** Plain, renderable reasoning text is available in this chunk. */
    readonly hasPlainReasoning: boolean
    /** The chunk carries an opaque encrypted reasoning payload. */
    readonly hasEncryptedReasoning: boolean
    /** Assistant text already started; reasoning UI must stay stable afterwards. */
    readonly assistantTextStarted: boolean
    /** A native tool call is already being streamed. */
    readonly hasPendingNativeToolUse: boolean
}

/**
 * Action the streaming loop must perform.
 *
 * - `publish_text`: render/refresh the reasoning row with plain text.
 * - `open_placeholder`: open a contentless row so the user sees activity.
 * - `none`: keep the current presentation untouched.
 */
export type ReasoningIndicatorAction = "publish_text" | "open_placeholder" | "none"

export class ReasoningIndicator {
    private placeholderOpen = false
    private publishedText = false

    /**
     * Decide the next action for a reasoning chunk.
     *
     * Encrypted reasoning arrives as many successive snapshots of the same item,
     * so a placeholder is opened at most once and never replaces a row that
     * already shows text.
     */
    decide(signals: ReasoningIndicatorSignals): ReasoningIndicatorAction {
        // Once text or a tool call owns the turn, reasoning UI stays frozen.
        if (signals.assistantTextStarted || signals.hasPendingNativeToolUse) {
            return "none"
        }

        if (signals.hasPlainReasoning) {
            this.publishedText = true
            // A placeholder row is reused by the text update, so it is no longer
            // contentless and must not be withdrawn later.
            this.placeholderOpen = false
            return "publish_text"
        }

        if (signals.hasEncryptedReasoning && !this.placeholderOpen && !this.publishedText) {
            this.placeholderOpen = true
            return "open_placeholder"
        }

        return "none"
    }

    /**
     * True when a contentless indicator is still open and no reasoning text ever
     * arrived, meaning the row would otherwise remain as an empty artifact.
     */
    get isPlaceholderOnly(): boolean {
        return this.placeholderOpen && !this.publishedText
    }

    /** Mark the open placeholder as resolved so it is not withdrawn twice. */
    onClosed(): void {
        this.placeholderOpen = false
    }
}
