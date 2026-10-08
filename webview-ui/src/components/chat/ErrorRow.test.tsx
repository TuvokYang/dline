import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ErrorRow from "./ErrorRow"

// Mock the auth context
vi.mock("@/context/ClineAuthContext", () => ({
	useClineAuth: () => ({
		clineUser: null,
	}),
	useClineSignIn: () => ({
		isLoginLoading: false,
	}),
	handleSignOut: vi.fn(),
}))

// Mock CreditLimitError component
vi.mock("@/components/chat/CreditLimitError", () => ({
	default: ({ message }: { message: string }) => <div data-testid="credit-limit-error">{message}</div>,
}))

// Mock ClineError
vi.mock("../../../../src/services/error/ClineError", () => ({
	ClineError: {
		parse: vi.fn(),
	},
	ClineErrorType: {
		Balance: "balance",
		RateLimit: "rateLimit",
		Auth: "auth",
	},
}))

describe("ErrorRow", () => {
	const mockMessage: UiMessage = {
		ts: 123456789,
		type: "say",
		say: "error",
		text: "Test error message",
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders basic error message", () => {
		render(<ErrorRow errorType="error" message={mockMessage} />)

		expect(screen.getByTestId("error-message-box")).toBeInTheDocument()
		expect(screen.getByText("Test error message")).toBeInTheDocument()
	})

	it("renders mistake limit reached error", () => {
		const mistakeMessage = { ...mockMessage, text: "Mistake limit reached" }
		render(<ErrorRow errorType="mistake_limit_reached" message={mistakeMessage} />)

		expect(screen.getByText("Mistake limit reached")).toBeInTheDocument()
	})

	it("renders diff error", () => {
		render(<ErrorRow errorType="diff_error" message={mockMessage} />)

		expect(
			screen.getByText("The model used search patterns that don't match anything in the file. Retrying..."),
		).toBeInTheDocument()
	})

	it("renders agentignore error", () => {
		const agentignoreMessage = { ...mockMessage, text: "/path/to/file.txt" }
		render(<ErrorRow errorType="clineignore_error" message={agentignoreMessage} />)

		expect(screen.getByText(/Dline tried to access/)).toBeInTheDocument()
		expect(screen.getByText("/path/to/file.txt")).toBeInTheDocument()
		expect(screen.getByText(".agentignore")).toBeInTheDocument()
		expect(screen.queryByText(".clineignore")).not.toBeInTheDocument()
	})

	describe("API error handling", () => {
		it("renders credit limit error when balance error is detected", async () => {
			const mockClineError = {
				message: "Insufficient credits",
				isErrorType: vi.fn((type) => type === "balance"),
				_error: {
					details: {
						current_balance: 0,
						total_spent: 10.5,
						total_promotions: 5.0,
						message: "You have run out of credits.",
						buy_credits_url: "https://app.dline.bot/dashboard",
					},
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Insufficient credits error" errorType="error" message={mockMessage} />)

			expect(screen.getByTestId("credit-limit-error")).toBeInTheDocument()
			expect(screen.getByText("You have run out of credits.")).toBeInTheDocument()
		})

		it("renders rate limit error with request ID", async () => {
			const mockClineError = {
				message: "Rate limit exceeded",
				isErrorType: vi.fn((type) => type === "rateLimit"),
				_error: {
					request_id: "req_123456",
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Rate limit exceeded" errorType="error" message={mockMessage} />)

			expect(screen.getByText("Rate limit exceeded")).toBeInTheDocument()
			expect(screen.getByText("Request ID")).toBeInTheDocument()
			expect(screen.getByTestId("api-error-box-request-id")).toHaveTextContent("req_123456")
		})

		it("renders quota exceeded error", async () => {
			const mockClineError = {
				message: "Inference cap reached",
				isErrorType: vi.fn((type) => type === "quotaexceeded"),
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="The message" errorType="error" message="" />)
			expect(screen.getByText("Inference cap reached")).toBeInTheDocument()
		})

		it("renders friendly logged-out message and sign in button when user is not signed in", async () => {
			const mockClineError = {
				message: "Authentication failed",
				isErrorType: vi.fn((type) => type === "auth"),
				providerId: "cline",
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Authentication failed" errorType="error" message={mockMessage} />)

			expect(screen.queryByText("Authentication failed")).not.toBeInTheDocument()
			expect(screen.getByText(/Whoops looks like you're logged out/)).toBeInTheDocument()
			expect(screen.getByText("Sign in to Dline")).toBeInTheDocument()
		})

		it("renders a PowerShell API failure without adding unrelated legacy content", async () => {
			const mockClineError = {
				message: "PowerShell is not recognized as an internal or external command",
				isErrorType: vi.fn(() => false),
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(
				<ErrorRow
					apiRequestFailedMessage="PowerShell is not recognized as an internal or external command"
					errorType="error"
					message={mockMessage}
				/>,
			)

			expect(screen.getByText(/PowerShell is not recognized/)).toBeInTheDocument()
			expect(screen.getByTestId("api-error-box")).toBeInTheDocument()
			expect(screen.queryByText("troubleshooting guide")).not.toBeInTheDocument()
			expect(screen.queryByText('(Click "Retry" below)')).not.toBeInTheDocument()
		})

		it("renders serialized provider failures once without raw JSON or retry instructions", async () => {
			const rawError = JSON.stringify({
				message: "500 No scripted E2E response remains for openai-compatible-chat",
				status: 500,
				code: "e2e_mock_queue_exhausted",
				modelId: "dline-e2e-model",
				providerId: "openai",
				details: {
					message: "No scripted E2E response remains for openai-compatible-chat",
					type: "e2e_mock_error",
					code: "e2e_mock_queue_exhausted",
				},
			})
			const mockClineError = {
				message: "500 No scripted E2E response remains for openai-compatible-chat",
				modelId: "dline-e2e-model",
				providerId: "openai",
				isErrorType: vi.fn(() => false),
				_error: {
					status: 500,
					code: "e2e_mock_queue_exhausted",
					message: "500 No scripted E2E response remains for openai-compatible-chat",
					details: {
						message: "No scripted E2E response remains for openai-compatible-chat",
						type: "e2e_mock_error",
						code: "e2e_mock_queue_exhausted",
					},
				},
			}
			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			const { container } = render(<ErrorRow apiRequestFailedMessage={rawError} errorType="error" message={mockMessage} />)

			expect(screen.getByTestId("api-error-box")).toBeInTheDocument()
			expect(screen.getByTestId("api-error-box-message")).toHaveTextContent(
				"No scripted E2E response remains for openai-compatible-chat",
			)
			expect(screen.queryByText('(Click "Retry" below)')).not.toBeInTheDocument()
			expect(container).not.toHaveTextContent(rawError)
		})

		it("handles apiReqStreamingFailedMessage instead of apiRequestFailedMessage", async () => {
			const mockClineError = {
				message: "Streaming failed",
				isErrorType: vi.fn(() => false),
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiReqStreamingFailedMessage="Streaming failed" errorType="error" message={mockMessage} />)

			expect(screen.getByText("Streaming failed")).toBeInTheDocument()
		})

		it("falls back to regular error message when ClineError.parse returns null", async () => {
			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(undefined)

			render(<ErrorRow apiRequestFailedMessage="Some API error" errorType="error" message={mockMessage} />)

			// When ClineError.parse returns null, we display the raw error message for non-Cline providers
			// Since clineError is undefined, isClineProvider is false, so we show the raw apiRequestFailedMessage
			expect(screen.getByText("Some API error")).toBeInTheDocument()
		})

		it("renders regular error message when no API error messages are provided", () => {
			render(<ErrorRow errorType="error" message={mockMessage} />)

			expect(screen.getByText("Test error message")).toBeInTheDocument()
		})
	})
})
