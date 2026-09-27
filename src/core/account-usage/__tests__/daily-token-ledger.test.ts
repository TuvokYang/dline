import { describe, expect, it } from "vitest"
import { addDailyTokens, localDayKey, readDailyTokens } from "../daily-token-ledger"

describe("daily token ledger", () => {
	const morning = new Date(2026, 8, 23, 9, 0, 0)
	const evening = new Date(2026, 8, 23, 22, 0, 0)
	const nextDay = new Date(2026, 8, 24, 0, 5, 0)

	it("keys days by the local calendar", () => {
		expect(localDayKey(morning)).toBe("2026-09-23")
		expect(localDayKey(nextDay)).toBe("2026-09-24")
	})

	it("accumulates a Profile's requests within one day", () => {
		let ledger = addDailyTokens({}, "claude", { inputTokens: 1_000, outputTokens: 200 }, morning)
		ledger = addDailyTokens(ledger, "claude", { inputTokens: 500, outputTokens: 50 }, evening)

		expect(readDailyTokens(ledger, "claude", evening)).toEqual({ inputTokens: 1_500, outputTokens: 250 })
	})

	it("keeps Profiles independent", () => {
		let ledger = addDailyTokens({}, "claude", { inputTokens: 10, outputTokens: 1 }, morning)
		ledger = addDailyTokens(ledger, "codex", { inputTokens: 20, outputTokens: 2 }, morning)

		expect(readDailyTokens(ledger, "claude", morning)).toEqual({ inputTokens: 10, outputTokens: 1 })
		expect(readDailyTokens(ledger, "codex", morning)).toEqual({ inputTokens: 20, outputTokens: 2 })
	})

	it("starts a new day from zero instead of carrying yesterday's totals", () => {
		let ledger = addDailyTokens({}, "claude", { inputTokens: 1_000, outputTokens: 200 }, evening)

		expect(readDailyTokens(ledger, "claude", nextDay)).toEqual({ inputTokens: 0, outputTokens: 0 })
		ledger = addDailyTokens(ledger, "claude", { inputTokens: 7, outputTokens: 3 }, nextDay)
		expect(readDailyTokens(ledger, "claude", nextDay)).toEqual({ inputTokens: 7, outputTokens: 3 })
	})

	it("ignores counts that cannot be tokens", () => {
		const ledger = addDailyTokens({}, "claude", { inputTokens: Number.NaN, outputTokens: -5 }, morning)

		expect(readDailyTokens(ledger, "claude", morning)).toEqual({ inputTokens: 0, outputTokens: 0 })
	})

	it("reports zero for a Profile that was never used", () => {
		expect(readDailyTokens(undefined, "claude", morning)).toEqual({ inputTokens: 0, outputTokens: 0 })
	})
})
