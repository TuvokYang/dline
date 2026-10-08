import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { readRestoredContextPressure } from "../RestoredContextPressure"

function request(ts: number, info: Record<string, unknown>): UiMessage {
	return { ts, type: "say", say: "api_req_started", text: JSON.stringify(info) } as UiMessage
}

describe("readRestoredContextPressure", () => {
	it("recovers the newest provider-reported occupancy from the kept request rows", () => {
		const messages = [request(1, { contextTokens: 1_000 }), request(2, { contextTokens: 125_100 })]

		expect(readRestoredContextPressure(messages, 100_000)).toEqual({ contextTokens: 125_100, compactTriggerTokens: 100_000 })
	})

	it("reports nothing when no request recorded reliable usage", () => {
		const messages = [request(1, { contextTokens: 50_000, contextTokensSource: "estimate" }), request(2, {})]

		expect(readRestoredContextPressure(messages, 100_000)).toBeUndefined()
	})

	it("reports nothing without a usable trigger", () => {
		expect(readRestoredContextPressure([request(1, { contextTokens: 125_100 })], 0)).toBeUndefined()
	})
})
