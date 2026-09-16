import { describe, expect, it } from "vitest"
import {
	decideModeSwitch,
	getContextTokens,
	getLatestReliableContextWindowTokens,
	readContextTokens,
	readContextWindowRequestPressure,
	resolveOccupiedContextWindowTokens,
} from "../context-pressure"
import { computeCompactTrigger, computeSummarizeBudget } from "../context-window-utils"

/** Verify canonical context-pressure accounting and mode-switch decisions. */
describe("context pressure", () => {
	/** Prefer the normalized occupancy persisted by the request finalizer. */
	it("prefers canonical contextTokens", () => {
		expect(getContextTokens({ tokensIn: 5_000, tokensOut: 500, cacheReads: 9_000, contextTokens: 14_500 })).toBe(14_500)
	})

	/** Preserve compatibility with request records created before canonical occupancy existed. */
	it("supports legacy usage", () => {
		expect(readContextTokens(JSON.stringify({ tokensIn: 5_000, tokensOut: 500, cacheReads: 9_000 }))).toBe(14_500)
	})

	/** Keep legacy display compatibility without treating malformed metadata as a reliable zero baseline. */
	it("separates unavailable pressure from the legacy zero token reader", () => {
		expect(readContextTokens("not-json")).toBe(0)
		expect(readContextWindowRequestPressure("not-json")).toBeUndefined()
		expect(readContextWindowRequestPressure(JSON.stringify({ request: "pending" }))).toEqual({})
	})

	/** Preserve estimate provenance until a positive provider usage sample replaces it. */
	it("reads estimate and provider pressure sources without inventing reliable usage", () => {
		expect(
			readContextWindowRequestPressure(JSON.stringify({ estimatedContextTokens: 42_000, contextTokensSource: "estimate" })),
		).toEqual({ estimatedContextTokens: 42_000, contextTokensSource: "estimate" })
		expect(
			readContextWindowRequestPressure(
				JSON.stringify({
					contextTokens: 45_000,
					estimatedContextTokens: 42_000,
					contextTokensSource: "provider",
				}),
			),
		).toEqual({
			contextTokens: 45_000,
			estimatedContextTokens: 42_000,
			contextTokensSource: "provider",
		})
	})

	/** Keep Profile preflight conservative while asynchronous indicator projection catches up. */
	it("uses the larger live indicator or latest persisted provider occupancy", () => {
		const pressures = [
			{ contextTokens: 20_443, contextTokensSource: "provider" },
			{ estimatedContextTokens: 379_467, contextTokensSource: "estimate" },
			{ contextTokens: 400_100, contextTokensSource: "provider" },
		] as const

		expect(getLatestReliableContextWindowTokens(pressures)).toBe(400_100)
		expect(resolveOccupiedContextWindowTokens(20_633, pressures)).toBe(400_100)
		expect(resolveOccupiedContextWindowTokens(420_000, pressures)).toBe(420_000)
	})

	/** Same-profile switches never require compaction confirmation. */
	it("skips warning for the same profile", () => {
		expect(
			decideModeSwitch({
				sourceProfile: "shared",
				targetProfile: "shared",
				sourceWindow: 128_000,
				targetWindow: 128_000,
				currentTokens: 120_000,
			}),
		).toEqual({ kind: "switch" })
	})

	/** Equal and larger target windows switch without compaction confirmation. */
	it("skips warning when the target window is not smaller", () => {
		expect(
			decideModeSwitch({
				sourceProfile: "source",
				targetProfile: "target",
				sourceWindow: 128_000,
				targetWindow: 200_000,
				currentTokens: 120_000,
			}),
		).toEqual({ kind: "switch" })
	})

	/** Smaller target windows warn only at the shared summary-aware trigger. */
	it("warns only when a smaller target window reaches its trigger", () => {
		const triggerTokens = computeCompactTrigger(128_000, computeSummarizeBudget())
		expect(
			decideModeSwitch({
				sourceProfile: "large",
				targetProfile: "small",
				sourceWindow: 272_000,
				targetWindow: 128_000,
				currentTokens: triggerTokens,
			}),
		).toEqual({ kind: "confirm", triggerTokens })
	})
})
