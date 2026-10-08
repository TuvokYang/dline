/** Rows the composer shows when it is empty; this defines its normal height. */
export const CHAT_INPUT_MIN_ROWS = 3

/** Tallest the composer grows, as a multiple of its normal height, before its content scrolls. */
export const CHAT_INPUT_MAX_HEIGHT_RATIO = 2.5

/** Top and bottom padding of the composer text, shared by the textarea and its highlight layer. */
export const CHAT_INPUT_PADDING_Y_PX = 9

/**
 * Row limit that caps the composer at CHAT_INPUT_MAX_HEIGHT_RATIO times its normal height.
 * Vertical padding does not grow with rows, so the exact limit depends on the measured row height;
 * until a row height is known the ratio is applied to rows alone.
 */
export function chatInputMaxRows(rowHeight?: number): number {
	const scaledRows = CHAT_INPUT_MIN_ROWS * CHAT_INPUT_MAX_HEIGHT_RATIO
	if (!rowHeight || rowHeight <= 0) {
		return scaledRows
	}
	const verticalPadding = 2 * CHAT_INPUT_PADDING_Y_PX
	return scaledRows + ((CHAT_INPUT_MAX_HEIGHT_RATIO - 1) * verticalPadding) / rowHeight
}
