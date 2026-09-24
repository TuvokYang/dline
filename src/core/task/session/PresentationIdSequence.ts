/**
 * One monotonic presentation-id sequence per task session.
 *
 * Chat rows are ordered by this id, so every producer of a row must draw from
 * the same sequence. The provider service seeds its own counter when the task
 * is composed and then increments it per block, which means its ids are not
 * wall-clock readings: a row stamped later with `Date.now()` can still sort
 * after blocks that were produced after it. Sharing one sequence is what keeps
 * "the user asked" ahead of "the assistant answered".
 *
 * The seed is a wall-clock reading so ids stay comparable with rows persisted
 * by earlier sessions, and the sequence only ever moves forward.
 */
export type PresentationIdSequence = () => number

export function createPresentationIdSequence(now: () => number = Date.now): PresentationIdSequence {
	let last = now()
	return () => {
		// A task can produce several rows inside one millisecond, so the counter
		// advances even when the clock has not.
		last = Math.max(last + 1, now())
		return last
	}
}
