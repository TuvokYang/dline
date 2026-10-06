import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderRetryGate } from "../ProviderRetryGate"

describe("ProviderRetryGate", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("waits out the countdown when nobody intervenes", async () => {
		const gate = new ProviderRetryGate()
		const waited = gate.wait(3_000, new AbortController().signal)

		await vi.advanceTimersByTimeAsync(2_999)
		let settled = false
		void waited.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await expect(waited).resolves.toBe("send")
	})

	// A manual Retry during the countdown must send the scheduled attempt now,
	// not start a second request beside it.
	it("sends the scheduled attempt as soon as the user retries", async () => {
		const gate = new ProviderRetryGate()
		const waited = gate.wait(30_000, new AbortController().signal)

		expect(gate.retryNow()).toBe(true)
		await expect(waited).resolves.toBe("send")
		// The countdown is spent; a second click has nothing left to release.
		expect(gate.retryNow()).toBe(false)
	})

	// A Profile switch ends the countdown of a failure the user left behind;
	// the request then fails instead of sending it again on its own.
	it("hands the countdown's failure back to the user instead of sending", async () => {
		const gate = new ProviderRetryGate()
		const waited = gate.wait(30_000, new AbortController().signal)

		expect(gate.handBack()).toBe(true)
		await expect(waited).resolves.toBe("handed_back")
		// Neither a late Retry nor the elapsed delay revives the countdown.
		expect(gate.retryNow()).toBe(false)
		expect(gate.handBack()).toBe(false)
	})

	it("ends the wait without retrying when the request is cancelled", async () => {
		const gate = new ProviderRetryGate()
		const controller = new AbortController()
		const waited = gate.wait(30_000, controller.signal)

		controller.abort()

		await expect(waited).resolves.toBe("cancelled")
		expect(gate.retryNow()).toBe(false)
		expect(gate.handBack()).toBe(false)
	})

	it("owns the footer from the first countdown until the request settles", async () => {
		const changes: boolean[] = []
		const gate = new ProviderRetryGate(() => changes.push(gate.active))
		expect(gate.active).toBe(false)

		const first = gate.wait(1_000, new AbortController().signal)
		await vi.advanceTimersByTimeAsync(1_000)
		await first
		// Between two countdowns the attempt is in flight; the footer stays.
		expect(gate.active).toBe(true)
		const second = gate.wait(1_000, new AbortController().signal)
		gate.retryNow()
		await second
		gate.settled()

		expect(gate.active).toBe(false)
		expect(changes).toEqual([true, false])
	})
})
