import type { AccountUsageData } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mockedContext = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const usageServiceMocks = vi.hoisted(() => ({
	consumeAccountUsageResetCredit: vi.fn(),
	getProviderUsage: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	__esModule: true,
	useExtensionState: () => mockedContext.value,
}))
vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: usageServiceMocks,
}))

class TestResizeObserver implements ResizeObserver {
	disconnect = vi.fn()
	observe = vi.fn()
	unobserve = vi.fn()
}

beforeAll(() => {
	globalThis.ResizeObserver = TestResizeObserver
	Object.defineProperties(HTMLElement.prototype, {
		hasPointerCapture: { configurable: true, value: () => false },
		releasePointerCapture: { configurable: true, value: () => undefined },
		setPointerCapture: { configurable: true, value: () => undefined },
	})
})

import { UsageBar } from "./UsageBar"

function usage(quotas: NonNullable<AccountUsageData["quotas"]>): AccountUsageData {
	return {
		profileId: "profile-a",
		providerId: "openai-codex",
		currency: "",
		quotas,
	}
}

describe("UsageBar", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		usageServiceMocks.consumeAccountUsageResetCredit.mockResolvedValue(undefined)
	})

	it("prefers the active five-hour window once it is below 100% remaining", () => {
		mockedContext.value = {
			accountUsage: usage([
				{ type: "5hour", label: "5 hour", used: 20, limit: 100 },
				{ type: "weekly", label: "7 day", used: 83, limit: 100 },
			]),
		}

		render(<UsageBar />)

		expect(screen.getByRole("button", { name: "Provider usage" })).toHaveTextContent("5h: 80%")
	})

	it("renders the tooltip like the details panel without its title or reset actions", async () => {
		const user = userEvent.setup()
		const resetCreditExpiresAt = "2030-03-25T00:00:00.000Z"
		mockedContext.value = {
			accountUsage: {
				...usage([
					{ type: "5hour", label: "5 hour", used: 20, limit: 100, resetAt: "2030-01-01T12:00:00.000Z" },
					{ type: "weekly", label: "7 day", used: 83, limit: 100 },
				]),
				planType: "plus",
				resetCreditsAvailableCount: 1,
				resetCredits: [{ id: "credit-a", expiresAt: resetCreditExpiresAt }],
			},
		}

		render(<UsageBar />)
		await user.hover(screen.getByRole("button", { name: "Provider usage" }))

		const tooltip = await screen.findByRole("tooltip")
		const visibleTooltip = document.querySelector('[data-usage-surface="preview"]')
		expect(visibleTooltip).toHaveClass("w-72", "overflow-visible", "border-dropdown-border", "bg-menu", "text-foreground")
		expect(visibleTooltip).toHaveAttribute("data-align", "end")
		expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1)
		expect(document.querySelector('[data-slot="click-menu-content"]')).not.toBeInTheDocument()
		expect(within(tooltip).getByText("80% remaining")).toBeInTheDocument()
		expect(within(tooltip).getByText("17% remaining")).toBeInTheDocument()
		const fiveHourProgress = within(tooltip).getByRole("progressbar", { name: "5 hour usage" })
		const weeklyProgress = within(tooltip).getByRole("progressbar", { name: "7 day usage" })
		expect(fiveHourProgress).toHaveAttribute("aria-valuenow", "80")
		expect(fiveHourProgress.firstElementChild).toHaveStyle({ width: "80%" })
		expect(fiveHourProgress).toHaveAttribute("data-usage-tone", "success")
		expect(weeklyProgress).toHaveAttribute("aria-valuenow", "17")
		expect(weeklyProgress.firstElementChild).toHaveStyle({ width: "17%" })
		expect(weeklyProgress).toHaveAttribute("data-usage-tone", "caution")
		expect(within(tooltip).queryByText(/% used/)).not.toBeInTheDocument()
		expect(within(tooltip).queryByText("Usage")).not.toBeInTheDocument()
		expect(within(tooltip).getByText("Reset cards: 1")).toBeInTheDocument()
		expect(within(tooltip).getByText("Next card expires")).toBeInTheDocument()
		expect(within(tooltip).getByText(new Date(resetCreditExpiresAt).toLocaleString())).toHaveClass("whitespace-nowrap")
		expect(within(tooltip).queryByText("Reset card 1")).not.toBeInTheDocument()
		expect(within(tooltip).queryByRole("button", { name: "Use reset card 1" })).not.toBeInTheDocument()
		expect(within(tooltip).getByText(/^Resets /)).toHaveClass("whitespace-nowrap")
	})

	it("closes the independent tooltip before mounting the click menu", async () => {
		const user = userEvent.setup()
		mockedContext.value = {
			accountUsage: {
				...usage([{ type: "5hour", label: "5 hour", used: 20, limit: 100 }]),
				resetCreditsAvailableCount: 1,
				resetCredits: [{ id: "credit-a", expiresAt: "2030-03-25T00:00:00.000Z" }],
			},
		}

		render(<UsageBar />)
		const trigger = screen.getByRole("button", { name: "Provider usage" })
		await user.hover(trigger)
		expect(document.querySelector('[data-usage-surface="preview"]')).toHaveAttribute("data-slot", "tooltip-content")
		expect(document.querySelector('[data-slot="click-menu-content"]')).not.toBeInTheDocument()

		fireEvent.pointerDown(trigger)
		expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeInTheDocument()
		fireEvent.click(trigger)

		const details = screen.getByRole("dialog", { name: "Provider usage details" })
		expect(details).toHaveAttribute("data-usage-surface", "details")
		expect(details).toHaveAttribute("data-slot", "click-menu-content")
		expect(details).toHaveClass("border-editor-group-border", "bg-menu", "text-menu-foreground", "shadow-lg")
		const resetRow = within(details).getByText("Reset card 1").closest("li")
		expect(resetRow).toHaveClass("items-center", "justify-between", "rounded-xs", "bg-toolbar-hover/30")
		expect(resetRow?.querySelector("[data-reset-credit-copy]")).toContainElement(within(details).getByText(/^Expires /))
		expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeInTheDocument()
		expect(document.querySelectorAll('[data-slot="click-menu-content"]')).toHaveLength(1)
		expect(document.querySelector('[data-slot="popover-content"]')).not.toBeInTheDocument()
	})

	it("applies the explicit refresh response without waiting for a state-stream update", async () => {
		mockedContext.value = {
			accountUsage: usage([{ type: "5hour", label: "5 hour", used: 20, limit: 100 }]),
		}
		usageServiceMocks.getProviderUsage.mockResolvedValue({
			profileId: "profile-a",
			providerId: "openai-codex",
			currency: "",
			quotas: [{ type: "5hour", label: "5 hour", used: 40, limit: 100 }],
		})

		render(<UsageBar />)
		const summary = screen.getByRole("button", { name: "Provider usage" })
		fireEvent.click(summary)
		fireEvent.click(screen.getByRole("button", { name: "Refresh Provider usage" }))

		await waitFor(() =>
			expect(usageServiceMocks.getProviderUsage).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-a" })),
		)
		await waitFor(() => expect(summary).toHaveTextContent("5h: 60%"))
	})
})
