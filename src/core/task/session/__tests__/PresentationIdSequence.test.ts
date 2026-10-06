import { describe, expect, it } from "vitest"
import { createPresentationIdSequence } from "../PresentationIdSequence"

describe("createPresentationIdSequence", () => {
	it("follows the clock and still advances inside one millisecond", () => {
		let clock = 1_000
		const next = createPresentationIdSequence(() => clock)

		expect(next()).toBe(1_001)
		expect(next()).toBe(1_002)
		clock = 5_000
		expect(next()).toBe(5_000)
	})

	it("draws after a persisted row whose id is ahead of the clock", () => {
		// A reopened history can end on rows numbered past the current clock.
		const latestRow = 9_000
		const next = createPresentationIdSequence(
			() => 1_000,
			() => latestRow,
		)

		const first = next()
		expect(first).toBe(latestRow + 1)
		expect(next()).toBe(latestRow + 2)
	})

	it("keeps moving forward when the latest row is withdrawn", () => {
		let latestRow: number | undefined = 9_000
		const next = createPresentationIdSequence(
			() => 1_000,
			() => latestRow,
		)

		const first = next()
		latestRow = undefined
		expect(next()).toBe(first + 1)
	})
})
