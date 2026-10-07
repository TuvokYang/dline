import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import OnboardingView from "./OnboardingView"

const mocks = vi.hoisted(() => ({
	accountLoginClicked: vi.fn(),
	captureOnboardingProgress: vi.fn(),
	setWelcomeViewCompleted: vi.fn(),
	hideAccount: vi.fn(),
	hideSettings: vi.fn(),
	setShowWelcome: vi.fn(),
}))

vi.mock("@/assets/DlineLogo", () => ({
	default: () => <div data-testid="dline-logo" />,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		hideAccount: mocks.hideAccount,
		hideSettings: mocks.hideSettings,
		setShowWelcome: mocks.setShowWelcome,
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: {
		accountLoginClicked: mocks.accountLoginClicked,
	},
	StateServiceClient: {
		captureOnboardingProgress: mocks.captureOnboardingProgress,
		setWelcomeViewCompleted: mocks.setWelcomeViewCompleted,
	},
}))

vi.mock("../settings/sections/ApiConfigurationSection", () => ({
	default: () => <div data-testid="api-configuration">API Configuration</div>,
}))

describe("OnboardingView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.accountLoginClicked.mockResolvedValue({ value: "https://example.test/login" })
		mocks.setWelcomeViewCompleted.mockResolvedValue({})
	})

	it("offers only account login and bring-your-own-key paths", () => {
		render(<OnboardingView />)

		expect(screen.getByText("Login / Sign up account")).toBeInTheDocument()
		expect(screen.getByText("Bring your own API key")).toBeInTheDocument()
		expect(screen.queryByText("Absolutely Free")).not.toBeInTheDocument()
		expect(screen.queryByText("Frontier Model")).not.toBeInTheDocument()
	})

	it("starts account login from the default selection", async () => {
		render(<OnboardingView />)

		fireEvent.click(screen.getByRole("button", { name: "Continue" }))

		await waitFor(() => expect(mocks.accountLoginClicked).toHaveBeenCalledOnce())
		expect(screen.getByText("Almost there!")).toBeInTheDocument()
		expect(mocks.hideAccount).toHaveBeenCalledOnce()
		expect(mocks.hideSettings).toHaveBeenCalledOnce()
	})

	it("opens API configuration for bring-your-own-key users", () => {
		render(<OnboardingView />)

		expect(screen.getByTestId("onboarding-step-content")).toHaveClass("max-w-lg")
		fireEvent.click(screen.getByText("Bring your own API key"))
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))

		expect(screen.getByTestId("api-configuration")).toBeInTheDocument()
		expect(screen.getByText("Configure your provider")).toBeInTheDocument()
		expect(screen.getByTestId("onboarding-step-content")).toHaveClass("w-full", "max-w-4xl")
		expect(mocks.accountLoginClicked).not.toHaveBeenCalled()
	})
})
