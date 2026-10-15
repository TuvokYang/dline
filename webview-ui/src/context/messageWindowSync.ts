import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * Reconciliation of the local message window against a fetched window.
 *
 * Merging by timestamp alone can only ever add or replace. When the backend
 * drops messages — a checkpoint restore truncating the chat tail, a cancel
 * discarding an empty placeholder — the local window keeps every timestamp it
 * has ever seen, so the removed rows stay on screen.
 *
 * A fetch answers with a contiguous slice of the conversation, so within the
 * absolute range it covers it is authoritative: a timestamp the backend did
 * not return in that range no longer exists. Outside the range the fetch says
 * nothing, and those messages must be preserved.
 */

/*
 * Which copy of one row (same `ts`) the Webview keeps.
 *
 * Rows arrive by two routes on one ordered channel. The realtime row stream
 * carries every change in the order the extension made it, so its latest frame
 * is the newest copy the Webview has seen. A window fetch is a snapshot: its
 * content dates from when the extension read it, which is earlier than when it
 * arrives, and every frame published before that read has already arrived ahead
 * of it. Two rules follow:
 *   - a row never returns from settled to partial;
 *   - a partial copy inside a fetch is never newer than the copy already held.
 */

/** Whether a realtime frame may replace the held copy of its row. */
export function realtimeFrameSupersedes(held: UiMessage, frame: UiMessage): boolean {
    return held.partial === true || frame.partial !== true
}

/** Whether a fetched copy may replace the held copy of its row. */
export function fetchedCopySupersedes(fetched: UiMessage): boolean {
    return fetched.partial !== true
}

/**
 * Swap each fetched row the fetch may not replace for the copy already held.
 *
 * @param held Rows currently rendered.
 * @param fetched Rows a fetch returned.
 * @returns `fetched`, with held copies kept where they take precedence.
 */
export function preferHeldCopies(held: readonly UiMessage[], fetched: UiMessage[]): UiMessage[] {
    const heldByTs = new Map(held.map((message) => [message.ts, message]))
    return fetched.map((message) => {
        const current = heldByTs.get(message.ts)
        return current && !fetchedCopySupersedes(message) ? current : message
    })
}

/**
 * Carry realtime rows that landed after a reconciliation into its result.
 *
 * A fetch is reconciled against the rows as last rendered, but realtime frames
 * queued since then are not rendered yet. Committing the reconciled rows as-is
 * would discard them, a settled row among them. Rows the reconciliation saw keep
 * its verdict; a row whose copy changed since then keeps the realtime copy when
 * that copy takes precedence; a row appended after the reconciled tail since
 * then is kept. Rows that appeared ahead of the tail are left out, as before,
 * because keeping them would shift the window start the reconciliation chose.
 *
 * @param current Rows as they stand now, including queued realtime frames.
 * @param base Rows the reconciliation was computed from.
 * @param reconciled Result of that reconciliation.
 * @returns `reconciled` with the later realtime rows applied.
 */
export function rebaseMessageWindow(
    current: readonly UiMessage[],
    base: readonly UiMessage[],
    reconciled: UiMessage[],
): UiMessage[] {
    if (current === base) return reconciled
    const baseByTs = new Map(base.map((message) => [message.ts, message]))
    const currentByTs = new Map(current.map((message) => [message.ts, message]))
    const kept = reconciled.map((message) => {
        const live = currentByTs.get(message.ts)
        const changedSince = live !== undefined && live !== baseByTs.get(message.ts)
        return changedSince && realtimeFrameSupersedes(message, live) ? live : message
    })
    const tailTs = reconciled.at(-1)?.ts ?? Number.NEGATIVE_INFINITY
    const appended = current.filter((message) => message.ts > tailTs && !baseByTs.has(message.ts))
    if (appended.length === 0) return kept
    return [...kept, ...appended].sort((left, right) => left.ts - right.ts)
}

/** A fetched window together with the absolute range it covers. */
export interface FetchedMessageWindow {
    /** Messages returned by the backend, ordered by timestamp. */
    messages: UiMessage[]
    /** Absolute index of the first returned message. */
    startIndex: number
    /** Total messages the backend holds, when reported. */
    total?: number
}

/** The local window, described the same way. */
export interface LocalMessageWindow {
    messages: UiMessage[]
    startIndex: number
}

/** Result of reconciling the local window against a fetched one. */
export interface ReconciledMessageWindow {
    messages: UiMessage[]
    startIndex: number
    /** True when the reconciliation dropped locally held messages. */
    removed: boolean
}

export interface MessageWindowReconciliationOptions {
    /**
     * Local timestamps present when the fetch started. A timestamp absent from
     * this set arrived after the backend snapshot began and must survive an
     * omission from that older snapshot.
     */
    localTimestampsAtFetchStart?: ReadonlySet<number>
    /** Keep in-flight rows while the task is actively streaming. */
    preserveOmittedPartials?: boolean
    /** The backend explicitly changed window membership, so omissions are deletions. */
    authoritativeOmissions?: boolean
}

/**
 * Merge a fetched window into the local one, honouring backend deletions.
 *
 * @param local Currently rendered window.
 * @param fetched Window just returned by the backend.
 * @returns Reconciled window and whether messages were dropped.
 */
export function reconcileMessageWindow(
    local: LocalMessageWindow,
    fetched: FetchedMessageWindow,
    options: MessageWindowReconciliationOptions = {},
): ReconciledMessageWindow {
    if (fetched.messages.length === 0) {
        // An empty answer proves deletion only when the backend also reports an
        // empty conversation. Otherwise it is a range that holds nothing yet.
        if (fetched.total === 0) {
            return { messages: [], startIndex: 0, removed: local.messages.length > 0 }
        }
        return { messages: local.messages, startIndex: local.startIndex, removed: false }
    }

    if (local.messages.length === 0) {
        return { messages: fetched.messages, startIndex: fetched.startIndex, removed: false }
    }

    const coveredFrom = fetched.startIndex
    const coveredTo = fetched.startIndex + fetched.messages.length - 1
    const localEndExclusive = local.startIndex + local.messages.length
    const fetchedEndExclusive = fetched.startIndex + fetched.messages.length
    const windowsTouch = fetched.startIndex <= localEndExclusive && fetchedEndExclusive >= local.startIndex
    if (local.messages.length > 0 && !windowsTouch) {
        // A disjoint fetch cannot be represented by the contiguous-window contract.
        // Keeping the current window is safer than inventing absolute indexes for
        // the gap; callers that intend a jump must replace the window explicitly.
        return { messages: local.messages, startIndex: local.startIndex, removed: false }
    }

    const authoritativeTs = new Set(fetched.messages.map((message) => message.ts))
    const oldestFetchedTs = fetched.messages[0].ts
    const newestFetchedTs = fetched.messages[fetched.messages.length - 1].ts
    const fetchedReachesBackendTail = fetched.total !== undefined && fetchedEndExclusive >= fetched.total

    // The fetch reports absolute indexes, but the local window indexes its own
    // slice. Timestamps are the only identity shared by both, so the covered
    // span is expressed as the timestamp interval the fetch actually returned.
    //
    // Two different questions are settled here, and conflating them is what
    // broke either deletion or ordering in the past:
    //   - which timestamps still exist: the fetch is authoritative inside its
    //     span, so a local message it omits has been deleted;
    //   - what a surviving timestamp contains: the fetch is not authoritative,
    //     because a slow response can carry an older snapshot than a realtime
    //     event that already arrived.
    const survivors: UiMessage[] = []
    const localByTs = new Map(local.messages.map((message) => [message.ts, message]))
    let removed = false

    for (const message of local.messages) {
        const withinFetchedSpan = message.ts >= oldestFetchedTs && message.ts <= newestFetchedTs
        // A latest-window fetch is also authoritative after its newest timestamp:
        // when it reaches the reported backend tail, a locally held later row is a
        // deleted tail row rather than content outside the fetched range.
        const beyondFetchedTail = fetchedReachesBackendTail && message.ts > newestFetchedTs
        const arrivedAfterFetchStarted = options.localTimestampsAtFetchStart?.has(message.ts) === false
        const preserveOmittedMessage =
            arrivedAfterFetchStarted ||
            (options.authoritativeOmissions !== true && message.partial === true && options.preserveOmittedPartials === true)
        if ((withinFetchedSpan || beyondFetchedTail) && !authoritativeTs.has(message.ts) && !preserveOmittedMessage) {
            removed = true
            continue
        }
        if (authoritativeTs.has(message.ts)) {
            continue
        }
        survivors.push(message)
    }

    const resolved = fetched.messages.map((fetchedMessage) => {
        const localMessage = localByTs.get(fetchedMessage.ts)
        if (!localMessage) {
            return fetchedMessage
        }
        // A settled fetch supersedes a local in-flight frame. Any other local copy
        // is at least as recent as this response, which may have been in flight
        // while a newer realtime frame arrived.
        return localMessage.partial === true && fetchedCopySupersedes(fetchedMessage) ? fetchedMessage : localMessage
    })

    const merged = [...survivors, ...resolved].sort((left, right) => left.ts - right.ts)

    // A survivor older than the fetched span still sits before it, so the window
    // start moves back to whichever of the two is lower.
    const leadingSurvivors = survivors.filter((message) => message.ts < oldestFetchedTs).length
    const startIndex = Math.max(0, Math.min(local.startIndex, coveredFrom - leadingSurvivors))

    // Keep the covered bound referenced so the intent of the range stays visible
    // to readers of this contract.
    void coveredTo

    return { messages: merged, startIndex, removed }
}

/**
 * Decide whether the local window can still be trusted against a total.
 *
 * @param localLength Number of locally held messages.
 * @param localStartIndex Absolute index of the first local message.
 * @param total Total messages reported by the backend.
 * @returns True when the local window claims more messages than exist.
 */
export function isMessageWindowOverfull(localLength: number, localStartIndex: number, total: number): boolean {
    return localStartIndex + localLength > total
}

/**
 * Report whether a realtime tail message may be appended to the current window.
 *
 * State and partial-message streams can arrive in either order, so a window that
 * ends one item before the reported total is still the live tail. A window with
 * a larger gap is an older browsing slice and must not receive a tail message.
 */
export function canAppendRealtimeMessage(localLength: number, localStartIndex: number, total: number): boolean {
    const localEndExclusive = localStartIndex + localLength
    return localEndExclusive >= Math.max(0, total - 1)
}
