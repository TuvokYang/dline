import { describe, expect, it } from "vitest"
import { CHAT_INPUT_MAX_HEIGHT_RATIO, CHAT_INPUT_MIN_ROWS, CHAT_INPUT_PADDING_Y_PX, chatInputMaxRows } from "../chat-input-height"

function composerHeight(rows: number, rowHeight: number): number {
	return rows * rowHeight + 2 * CHAT_INPUT_PADDING_Y_PX
}

describe("chatInputMaxRows", () => {
	it.each([14, 19, 22.5])("caps the composer at 2.5x its normal height for %spx rows", (rowHeight) => {
		const normalHeight = composerHeight(CHAT_INPUT_MIN_ROWS, rowHeight)
		const maxHeight = composerHeight(chatInputMaxRows(rowHeight), rowHeight)

		expect(CHAT_INPUT_MAX_HEIGHT_RATIO).toBe(2.5)
		expect(maxHeight).toBeCloseTo(normalHeight * 2.5, 6)
	})

	it("scales rows alone until a row height has been measured", () => {
		expect(chatInputMaxRows()).toBe(CHAT_INPUT_MIN_ROWS * 2.5)
		expect(chatInputMaxRows(0)).toBe(CHAT_INPUT_MIN_ROWS * 2.5)
	})
})
