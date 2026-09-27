import type { AccountUsageData } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAiCodexUsage } from "./OpenAiCodexUsage"
import { providerUsageProgressTone, selectEffectiveUsageQuota } from "./ProviderUsageDetails"

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
	consumeResetCredit: vi.fn(),
	useUsage: vi.fn(),
}))

vi.mock("./useProviderUsage", () => ({
	useProviderUsage: mocks.useUsage,
}))

const usage: AccountUsageData = {
	profileId: "profile-a",
	providerId: "openai-codex",
	currency: "",
	planType: "pro",
	quotas: [
		{ type: "5hour", label: "5 hour", used: 50, limit: 100, windowSeconds: 18_000 },
		{ type: "weekly", label: "7 day", used: 80, limit: 100, windowSeconds: 604_800 },
	],
	resetCreditsAvailableCount: 1,
	resetCredits: [{ id: "credit-a", expiresAt: "2030-03-25T00:00:00.000Z" }],
	allowed: true,
	limitReached: false,
	isAvailable: true,
}

describe("ProviderUsage through OpenAiCodexUsage compatibility", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.refresh.mockResolvedValue(usage)
		mocks.consumeResetCredit.mockResolvedValue({
			profileId: "profile-a",
			outcome: "reset",
			quotaTypesReset: ["primary", "secondary"],
			usage: undefined,
		})
		mocks.useUsage.mockReturnValue({
			usage,
			loading: false,
			refreshing: false,
			resetting: false,
			error: undefined,
			resetError: undefined,
			refresh: mocks.refresh,
			consumeResetCredit: mocks.consumeResetCredit,
		})
	})

	it("uses the tighter quota as the compact summary and expands both windows", () => {
		expect(selectEffectiveUsageQuota(usage.quotas ?? [])?.type).toBe("weekly")
		render(<OpenAiCodexUsage enabled profileId="profile-a" />)

		const summary = screen.getByRole("button", { name: "Usage 7 day 20%" })
		expect(summary).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(summary)

		expect(summary).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText("5 hour")).toBeInTheDocument()
		expect(screen.getAllByText("7 day").length).toBeGreaterThan(0)
		expect(screen.getByText("50% remaining")).toBeInTheDocument()
		expect(screen.getByText("20% remaining")).toBeInTheDocument()
		expect(screen.getByRole("progressbar", { name: "5 hour usage" })).toHaveAttribute("aria-valuenow", "50")
		expect(screen.getByRole("progressbar", { name: "7 day usage" })).toHaveAttribute("aria-valuenow", "20")
		expect(screen.getByRole("progressbar", { name: "7 day usage" }).firstElementChild).toHaveStyle({ width: "20%" })
		expect(screen.getByText("Reset cards: 1")).toBeInTheDocument()
	})

	it("hides the reset-card section for a provider that has no reset-credit capability", () => {
		// A provider such as anthropic decodes to `undefined` for both reset-credit
		// fields, which must hide the section rather than render "Reset cards: none".
		const { resetCredits: _credits, resetCreditsAvailableCount: _count, ...withoutResetCredits } = usage
		mocks.useUsage.mockReturnValue({
			usage: withoutResetCredits,
			loading: false,
			refreshing: false,
			resetting: false,
			error: undefined,
			resetError: undefined,
			refresh: mocks.refresh,
			consumeResetCredit: mocks.consumeResetCredit,
		})

		render(<OpenAiCodexUsage enabled profileId="profile-a" />)
		fireEvent.click(screen.getByRole("button", { name: "Usage 7 day 20%" }))

		expect(screen.queryByText(/Reset cards/)).not.toBeInTheDocument()
		// The rest of the usage panel must keep rendering.
		expect(screen.getByText("50% remaining")).toBeInTheDocument()
	})

	it("reports an exhausted balance for a provider that supports reset cards but has none left", () => {
		mocks.useUsage.mockReturnValue({
			usage: { ...usage, resetCredits: [], resetCreditsAvailableCount: 0 },
			loading: false,
			refreshing: false,
			resetting: false,
			error: undefined,
			resetError: undefined,
			refresh: mocks.refresh,
			consumeResetCredit: mocks.consumeResetCredit,
		})

		render(<OpenAiCodexUsage enabled profileId="profile-a" />)
		fireEvent.click(screen.getByRole("button", { name: "Usage 7 day 20%" }))

		// Zero is a real state here and stays visible, unlike the absent capability.
		expect(screen.getByText("Reset cards: none")).toBeInTheDocument()
	})

	it("requires confirmation before consuming a reset card", async () => {
		render(<OpenAiCodexUsage enabled profileId="profile-a" />)
		fireEvent.click(screen.getByRole("button", { name: "Usage 7 day 20%" }))
		fireEvent.click(screen.getByRole("button", { name: "Use reset card 1" }))

		expect(mocks.consumeResetCredit).not.toHaveBeenCalled()
		expect(screen.getByRole("dialog", { name: "Use a rate-limit reset card?" })).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Use reset card" }))

		await waitFor(() => expect(mocks.consumeResetCredit).toHaveBeenCalledWith("credit-a"))
		expect(await screen.findByText("Reset completed for primary and secondary.")).toBeInTheDocument()
	})

	it("colors the progress bar by remaining capacity", () => {
		expect(providerUsageProgressTone(100)).toBe("success")
		expect(providerUsageProgressTone(40.01)).toBe("success")
		expect(providerUsageProgressTone(40)).toBe("warning")
		expect(providerUsageProgressTone(20)).toBe("warning")
		expect(providerUsageProgressTone(19.99)).toBe("caution")
		expect(providerUsageProgressTone(1)).toBe("caution")
		expect(providerUsageProgressTone(0)).toBe("danger")
	})
})
