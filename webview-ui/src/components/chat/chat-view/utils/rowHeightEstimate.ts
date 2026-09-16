import type { ClineMessage } from "@shared/ExtensionMessage"

/**
 * Height a fenced code block contributes per line of code, in pixels.
 *
 * Taken from the measured transcript: an eighteen-line block rendered at 431px
 * against a 68px row without one, which puts each code line near 20px once the
 * block's own padding and border are accounted for separately.
 */
const CODE_LINE_HEIGHT = 20

/** Padding, border, and copy-button chrome a fenced block adds once. */
const CODE_BLOCK_CHROME = 34

/** Height of the message row itself around whatever body it carries. */
const ROW_CHROME = 41

/**
 * Rows shorter than this are left to the list's own default.
 *
 * The jitter comes from rows that are dramatically taller than the library
 * assumes; ordinary rows are already close enough that estimating them adds
 * risk without removing a visible jump. Measured ordinary rows ranged from
 * 24px to 109px, so this sits above them.
 */
const WORTH_ESTIMATING = 150

/** Opening fence of a markdown code block, capturing the fence run. */
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/

/**
 * Estimate how tall a message will render, or undefined when it should be left
 * to the list's own default.
 *
 * A virtual list has to place a row before it exists, and correcting a wrong
 * assumption means moving the scroll position under the reader. The one body
 * that is reliably far taller than a default row — a fenced code block — can be
 * recognised and counted from the message text before anything renders.
 *
 * Returning undefined for everything else is deliberate. A previous attempt
 * estimated every row from its line count and inflated the transcript sixfold,
 * which moved the view further than the problem it was meant to fix. Only
 * bodies whose height follows directly from the text are claimed here.
 *
 * @param message Message about to be rendered.
 * @returns Estimated row height in pixels, or undefined to use the default.
 */
export function estimateMessageHeight(message: ClineMessage): number | undefined {
	const text = message.text
	if (!text || !text.includes("```")) return undefined

	let codeLines = 0
	let fence: string | null = null
	for (const line of text.split("\n")) {
		if (fence === null) {
			const opening = FENCE_PATTERN.exec(line)
			if (opening) fence = opening[1]
			continue
		}
		// A closing fence must be at least as long as the one that opened it,
		// which is what allows a block to contain shorter backtick runs.
		const closing = FENCE_PATTERN.exec(line)
		if (closing && closing[1].length >= fence.length) {
			fence = null
			continue
		}
		codeLines += 1
	}

	// An unterminated fence means the message is still streaming in; its final
	// height is not knowable yet, so the count so far is all there is to go on.
	if (codeLines === 0) return undefined

	const estimate = ROW_CHROME + CODE_BLOCK_CHROME + codeLines * CODE_LINE_HEIGHT
	return estimate >= WORTH_ESTIMATING ? estimate : undefined
}

/**
 * Estimate the height of a rendered row.
 *
 * Grouped rows stack their messages, so their estimate is the sum. A group is
 * only claimed when at least one of its messages is worth estimating.
 *
 * @param row Row about to be rendered.
 * @returns Estimated height in pixels, or undefined to use the default.
 */
export function estimateRowHeight(row: ClineMessage | ClineMessage[]): number | undefined {
	if (!Array.isArray(row)) return estimateMessageHeight(row)

	let total = 0
	let claimed = false
	for (const message of row) {
		const estimate = estimateMessageHeight(message)
		if (estimate === undefined) continue
		total += estimate
		claimed = true
	}
	return claimed ? total : undefined
}
