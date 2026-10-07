/** The only part of a message that identifies its row in the rendered window. */
export interface MessageIdentity {
	ts: number
}

/**
 * Whether an update to the message window changed nothing but its end.
 *
 * A streaming reply rewrites the last message in place and appends new ones
 * after it. Neither can move a row the reader is looking at: everything the
 * reader sees sits above the tail, and a row above the viewport that changes
 * size is compensated by the virtual list itself. An update like this needs no
 * anchor restore, and arming one lets the restore read the reader's own
 * in-flight scroll as displacement and undo it.
 *
 * Anything else — older history merged in at the top, the window sliding, a
 * row removed from the middle, a different conversation — changes which rows
 * precede the reader's anchor and still needs the restore.
 *
 * Only the two ends of the previous window are compared: the window changes
 * by sliding or growing at either end, so a prefix whose first and last rows
 * kept their positions is unchanged.
 */
export function isTailOnlyUpdate(previous: readonly MessageIdentity[], next: readonly MessageIdentity[]): boolean {
	const lastIndex = previous.length - 1
	if (lastIndex < 0 || next.length < previous.length) return false
	return next[0]?.ts === previous[0]?.ts && next[lastIndex]?.ts === previous[lastIndex]?.ts
}
