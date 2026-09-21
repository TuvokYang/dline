/**
 * When inline input text becomes a file instead.
 *
 * A long paste is content, not a message: keeping it inline buries the user's
 * own words and re-sends the whole block on every later turn. Past these
 * budgets the text is stored as a task-owned file and referenced instead.
 */
export const INLINE_TEXT_MAX_LINES = 20

/** Measured in UTF-8 bytes, because that is what the provider is billed for. */
export const INLINE_TEXT_MAX_BYTES = 5000

const UTF8 = new TextEncoder()

export function countTextLines(text: string): number {
	if (text.length === 0) return 0
	return text.split("\n").length
}

export function countUtf8Bytes(text: string): number {
	return UTF8.encode(text).length
}

/** Whether this text must be stored as a resource rather than sent inline. */
export function exceedsInlineTextBudget(text: string): boolean {
	return countTextLines(text) > INLINE_TEXT_MAX_LINES || countUtf8Bytes(text) > INLINE_TEXT_MAX_BYTES
}
