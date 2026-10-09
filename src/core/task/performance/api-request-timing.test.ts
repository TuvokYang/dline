import { describe, expect, it } from "vitest"
import { calculateApiRequestTiming, formatApiRequestTiming } from "./api-request-timing"

describe("calculateApiRequestTiming", () => {
	it("separates local preparation, upstream TTFB, stream consumption, and total duration", () => {
		expect(
			calculateApiRequestTiming({
				requestStartedAtMs: 100,
				providerRequestStartedAtMs: 350,
				firstChunkAtMs: 500,
				streamCompletedAtMs: 900,
			}),
		).toEqual({
			localPrepareMs: 250,
			upstreamTtfbMs: 150,
			streamMs: 400,
			totalMs: 800,
		})
	})

	it("clamps invalid clock ordering to zero-length phases", () => {
		expect(
			calculateApiRequestTiming({
				requestStartedAtMs: 500,
				providerRequestStartedAtMs: 400,
				firstChunkAtMs: 300,
				streamCompletedAtMs: 200,
			}),
		).toEqual({
			localPrepareMs: 0,
			upstreamTtfbMs: 0,
			streamMs: 0,
			totalMs: 0,
		})
	})
})

describe("formatApiRequestTiming", () => {
	it("keeps the diagnostic shape consumed by performance E2E tests", () => {
		expect(
			formatApiRequestTiming({
				taskId: "task-42",
				request: 3,
				timing: {
					localPrepareMs: 12,
					upstreamTtfbMs: 34,
					streamMs: 56,
					totalMs: 102,
				},
				activeTasks: 4,
			}),
		).toBe(
			"[Task task-42] API timing: request=3, localPrepareMs=12, upstreamTtfbMs=34, streamMs=56, totalMs=102, activeTasks=4",
		)
	})
})
