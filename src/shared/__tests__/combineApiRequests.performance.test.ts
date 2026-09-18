import { describe, expect, it } from "vitest"
import { combineApiRequests } from "../combineApiRequests"
import { type ClineMessage } from "../ExtensionMessage"

/**
 * Performance regression lock for combineApiRequests.
 *
 * RED baseline: the implementation resolves each api_req_started against
 * combinedApiRequests with a linear `find`, i.e. O(N^2) in the number of
 * paired API request messages. At ~8000 pairs the single-call duration is
 * expected to exceed 500ms, matching the user-reported
 * `getStateToPostToWebview took 900-2500ms` logs.
 *
 * The primary assertion is an absolute threshold (>=500ms scale); the
 * doubling-ratio assertion is secondary to tolerate CI jitter.
 */

const PAIR_SIZES = [1_000, 2_000, 4_000, 8_000] as const

const ABSOLUTE_THRESHOLD_MS = 500
const RATIO_THRESHOLD = 3.2
/**
 * Smallest baseline a doubling ratio is computed from.
 *
 * Below this the measurement is dominated by scheduling and GC noise rather
 * than the work being measured. Shared CI runners have produced 6ms baselines
 * whose paired sample was preempted long enough to look quadratic, while the
 * 8000-pair hard limit remained two orders of magnitude below the regression
 * threshold. The absolute assertion still bounds real growth, so skipping a
 * sub-10ms baseline drops noise rather than coverage.
 */
const MIN_RATIO_BASELINE_MS = 10

function buildPairedApiRequestMessages(pairCount: number): ClineMessage[] {
	const messages: ClineMessage[] = []
	let ts = 1_700_000_000_000
	for (let i = 0; i < pairCount; i++) {
		messages.push({
			ts: ts++,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ request: `GET /resource/${i}`, provider: "openai", model: "test-model" }),
		})
		messages.push({
			ts: ts++,
			type: "say",
			say: "api_req_finished",
			text: JSON.stringify({ cost: 0.001, tokensIn: 100, tokensOut: 50 }),
		})
	}
	return messages
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function measureOnce(messages: ClineMessage[]): number {
	const start = performance.now()
	combineApiRequests(messages)
	return performance.now() - start
}

function measureMedian(messages: ClineMessage[], samples: number): number {
	// Warm up before measuring so JIT/GC warm state matches steady state.
	combineApiRequests(messages)
	const runs: number[] = []
	for (let i = 0; i < samples; i++) {
		runs.push(measureOnce(messages))
	}
	return median(runs)
}

describe("combineApiRequests performance lock", () => {
	it("keeps single-call duration below 500ms at 8000 API request pairs", () => {
		const messages = buildPairedApiRequestMessages(8_000)
		const elapsed = measureMedian(messages, 5)

		expect(
			elapsed,
			`combineApiRequests(8000 pairs) took ${elapsed.toFixed(1)}ms; ` +
				"expected < 500ms. O(N^2) lookup on api_req_started messages is active (see combinedApiRequests.find).",
		).toBeLessThan(ABSOLUTE_THRESHOLD_MS)
	})

	it("scales sub-quadratically when the message count doubles (t(2N)/t(N) < 3.2)", () => {
		const timings = new Map<number, number>()
		for (const size of PAIR_SIZES) {
			timings.set(size, measureMedian(buildPairedApiRequestMessages(size), 5))
		}

		for (let i = 1; i < PAIR_SIZES.length; i++) {
			const small = PAIR_SIZES[i - 1]
			const large = PAIR_SIZES[i]
			const smallMs = timings.get(small)!
			const largeMs = timings.get(large)!
			if (smallMs < MIN_RATIO_BASELINE_MS) {
				continue
			}
			const ratio = largeMs / smallMs

			expect(
				ratio,
				`t(${large})/t(${small}) = ${ratio.toFixed(2)} (${smallMs.toFixed(1)}ms -> ${largeMs.toFixed(1)}ms); ` +
					"expected < 3.2 (linear ~2x). O(N^2) lookup is active when the ratio approaches 4x.",
			).toBeLessThan(RATIO_THRESHOLD)
		}
	})

	it("keeps a safety upper bound at 4000 pairs to detect environment-wide degradation", () => {
		const messages = buildPairedApiRequestMessages(4_000)
		const elapsed = measureMedian(messages, 3)

		expect(elapsed, `combineApiRequests(4000 pairs) took ${elapsed.toFixed(1)}ms`).toBeLessThan(5_000)
	})
})
