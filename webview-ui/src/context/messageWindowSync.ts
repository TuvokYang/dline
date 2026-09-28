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
	 * Local timestamps present when the fetch started. A partial timestamp absent
	 * from this set arrived after the backend snapshot began and must survive an
	 * omission from that older snapshot.
	 */
	localTimestampsAtFetchStart?: ReadonlySet<number>
	/** Keep in-flight rows while the task is actively streaming. */
	preserveOmittedPartials?: boolean
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
		const preserveOmittedPartial =
			message.partial === true &&
			(options.preserveOmittedPartials === true || options.localTimestampsAtFetchStart?.has(message.ts) === false)
		if (withinFetchedSpan && !authoritativeTs.has(message.ts) && !preserveOmittedPartial) {
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
		// A local partial is an in-flight frame; the durable fetch supersedes it.
		// Otherwise the local copy is at least as recent as this response, which
		// may have been in flight while a newer realtime event arrived.
		return localMessage.partial === true ? fetchedMessage : localMessage
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
