import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderUsage } from "./ProviderUsage"

const mocks = vi.hoisted(() => ({
	getProviderUsage: vi.fn(),
	consumeAccountUsageResetCredit: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: {
		getProviderUsage: mocks.getProviderUsage,
		consumeAccountUsageResetCredit: mocks.consumeAccountUsageResetCredit,
	},
}))

/** One quota window, shaped as the conversion boundary delivers it. */
const USAGE_RESPONSE = {
	profileId: "profile-a",
	providerId: "claude-code",
	currency: "USD",
	isAvailable: true,
	allowed: true,
	limitReached: false,
	quotas: [{ type: "5hour", label: "5 hour", used: 20, limit: 100, windowSeconds: 18_000 }],
	resetCredits: [],
	resetCreditsAvailableCount: 0,
}

describe("ProviderUsage polling policy", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		mocks.getProviderUsage.mockReset()
		mocks.getProviderUsage.mockResolvedValue(USAGE_RESPONSE)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("reads the snapshot once when the provider opts out of the timer", async () => {
		render(<ProviderUsage enabled pollIntervalMs={null} profileId="profile-a" />)

		await waitFor(() => expect(mocks.getProviderUsage).toHaveBeenCalledTimes(1))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5 * 60_000)
		})

		// A subscription usage read is billed against the same account that
		// serves conversations, so the timer must not spend that budget.
		expect(mocks.getProviderUsage).toHaveBeenCalledTimes(1)
	})

	it("keeps polling on the default interval for a provider that allows it", async () => {
		render(<ProviderUsage enabled profileId="profile-a" />)

		await waitFor(() => expect(mocks.getProviderUsage).toHaveBeenCalledTimes(1))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000)
		})

		await waitFor(() => expect(mocks.getProviderUsage).toHaveBeenCalledTimes(2))
	})

	it("resumes the timer once a manual refresh succeeds after a transient failure", async () => {
		mocks.getProviderUsage.mockRejectedValueOnce(new Error("socket closed"))

		render(<ProviderUsage enabled profileId="profile-a" />)

		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
		screen.getByRole("button", { name: "Refresh Provider usage" }).click()
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())

		const afterRecovery = mocks.getProviderUsage.mock.calls.length
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000)
		})

		// A network blip must not silently disable the timer for the rest of the
		// session: the banner is gone, so a stopped timer would be invisible.
		await waitFor(() => expect(mocks.getProviderUsage.mock.calls.length).toBeGreaterThan(afterRecovery))
	})

	it("stops the timer after a failed read instead of retrying on every tick", async () => {
		mocks.getProviderUsage.mockRejectedValue(new Error("401"))

		render(<ProviderUsage enabled profileId="profile-a" />)

		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Provider usage could not be loaded."))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5 * 60_000)
		})

		// A rejected credential is not resolved by waiting, so repeating the
		// request would only multiply a failure the user must fix by signing in.
		expect(mocks.getProviderUsage).toHaveBeenCalledTimes(1)
	})
})
