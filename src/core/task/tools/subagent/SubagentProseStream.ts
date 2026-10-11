import { assistantProse, streamingProse } from "@core/task/executors/provider/service/XmlToolPreview"

/**
 * Turns a subagent reply that grows chunk by chunk into the prose its activity shows.
 *
 * Activity events append deltas, and a delta once shown cannot be withdrawn, so
 * tool markup never leaves this stream: a call written as XML is an invocation,
 * not something the subagent said, and a trailing tag that may still open one is
 * held back until the parser can tell which it is.
 */
export class SubagentProseStream {
    private shown = ""

    /**
     * The prose the reply added since the previous call.
     *
     * @param reply The whole reply received so far in this request.
     * @returns The new prose, or an empty string when nothing new may be shown yet.
     */
    next(reply: string): string {
        const prose = streamingProse(reply)
        // Prose only grows while a reply streams; should a re-parse ever disagree with
        // what was shown, wait for the final prose instead of appending a contradiction.
        if (!prose.startsWith(this.shown)) return ""
        const delta = prose.slice(this.shown.length)
        this.shown = prose
        return delta
    }

    /** The complete prose of a finished reply. */
    static final(reply: string): string {
        return assistantProse(reply)
    }
}
