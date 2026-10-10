import { UiMessage } from "@shared/ExtensionMessage"
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import type { ClineAuthContextType } from "@/context/ClineAuthContext"
import ErrorRow from "./ErrorRow"

// Mock data factories
const createMockMessage = (overrides: Partial<UiMessage> = {}): UiMessage => ({
    ts: Date.now(),
    type: "say",
    say: "error",
    text: "An error occurred while processing your request.",
    ...overrides,
})

// Reusable decorator that only overrides the auth fields this component consumes.
const createStoryDecorator = (authOverrides: Partial<ClineAuthContextType> = {}): Decorator =>
    createStorybookDecorator(undefined, "p-4", authOverrides)

const meta: Meta<typeof ErrorRow> = {
    title: "Views/Components/ErrorRow",
    component: ErrorRow,
    parameters: {
        docs: {
            description: {
                component:
                    "Displays different types of error messages in the chat interface, including API errors, credit limit errors, diff errors, and clineignore errors. Handles special error parsing for Cline provider errors and provides appropriate user actions.",
            },
        },
    },
    decorators: [createStoryDecorator()],
}

export default meta
type Story = StoryObj<typeof ErrorRow>

// Interactive plain text error story with configurable args and presets
export const Default: Story = {
    args: {
        message: createMockMessage({ text: "Something went wrong while executing the command." }),
        errorType: "error",
        apiRequestFailedMessage: undefined,
    },
    argTypes: {
        errorType: {
            control: { type: "select" },
            options: ["error", "mistake_limit_reached", "diff_error", "clineignore_error"],
            description: "Type of error to display",
        },
        message: {
            control: { type: "object" },
            description: "Message object containing error text and metadata",
        },
        apiRequestFailedMessage: {
            control: { type: "select" },
            options: [
                // Empty option for no error message
                "",
                // PowerShell error
                "PowerShell is not recognized as an internal or external command, operable program or batch file.",
                JSON.stringify({
                    request_id: "has-request-id",
                    message: "error message.",
                    code: "random_code",
                }),
            ],
        },
    },
    parameters: {
        docs: {
            description: {
                story: "Interactive story for testing different plain text error types and messages. Use the preset dropdown to quickly test common scenarios, or manually configure the error type and message object.",
            },
        },
    },
}

// API request errors
export const ApiRequestFailed: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage:
            "Network error: Unable to connect to the API server. Please check your internet connection and try again.",
    },
}

export const ApiStreamingFailed: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiReqStreamingFailedMessage: "Streaming error: Connection was interrupted while receiving the response.",
    },
}

// Cline-specific errors
export const ClineBalanceError: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "Insufficient credits to complete this request.",
            code: "insufficient_credits",
            request_id: "req_123456789",
            providerId: "cline",
            details: {
                current_balance: 0.5,
                total_spent: 25.75,
                total_promotions: 5.0,
                message: "You have run out of credits. Please purchase more to continue.",
                buy_credits_url: "https://app.example.bot/dashboard/account?tab=credits&redirect=true",
            },
        }),
    },
}

export const ClineRateLimitError: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "Rate limit exceeded. Please wait before making another request.",
            request_id: "req_987654321",
            providerId: "cline",
        }),
    },
}

export const ClineSpendLimitDaily: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "$20.00 daily limit has been reached.",
            status: 429,
            code: "SPEND_LIMIT_EXCEEDED",
            providerId: "cline",
            details: {
                code: "SPEND_LIMIT_EXCEEDED",
                limit_scope: "user",
                budget_period: "daily",
                limit_usd: 20.0,
                spent_usd: 20.5,
                resets_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
                message: "$20.00 daily limit has been reached.",
            },
        }),
    },
}

export const ClineSpendLimitMonthly: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "$100.00 monthly limit has been reached.",
            status: 429,
            code: "SPEND_LIMIT_EXCEEDED",
            providerId: "cline",
            details: {
                code: "SPEND_LIMIT_EXCEEDED",
                limit_scope: "user",
                budget_period: "monthly",
                limit_usd: 100.0,
                spent_usd: 103.22,
                resets_at: null,
                message: "$100.00 monthly limit has been reached.",
            },
        }),
    },
}

export const ClineSpendLimitMinimal: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "Spend limit reached.",
            status: 429,
            code: "SPEND_LIMIT_EXCEEDED",
            providerId: "cline",
            details: {
                code: "SPEND_LIMIT_EXCEEDED",
                message: "Spend limit reached.",
            },
        }),
    },
}

// Authentication-related errors with configurable scenarios
export const AuthenticationErrors: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "Authentication failed. Please sign in to continue.",
            code: "ERR_BAD_REQUEST",
            request_id: "req_auth_123",
            providerId: "cline",
        }),
    },
    argTypes: {
        apiRequestFailedMessage: {
            control: { type: "text" },
            description: "JSON string containing error details",
        },
    },
    parameters: {
        docs: {
            description: {
                story: "Interactive story for testing authentication-related errors. Configure the error message JSON to test different auth scenarios including signed in/out states.",
            },
        },
    },
}

// Auth error when signed in (shows different UI)
export const AuthErrorSignedIn: Story = {
    ...AuthenticationErrors,
    decorators: [
        createStoryDecorator({
            clineUser: { uid: "user123", email: "user@example.com" },
        }),
    ],
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "Authentication failed. Please retry your request.",
            request_id: "req_auth_456",
            providerId: "anthropic",
        }),
    },
}

// Interactive tests
export const InteractiveSignIn: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "Please sign in to access Cline services.",
            code: "ERR_BAD_REQUEST",
            request_id: "req_signin_test",
            providerId: "cline",
        }),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)

        // Keep the story assertion aligned with the current product branding.
        const signInButton = canvas.getByRole("button", { name: /sign in to dline/i })
        await expect(signInButton).toBeInTheDocument()

        // Test button is clickable
        await expect(signInButton).toBeEnabled()

        // Click the button (this will trigger the mock handler)
        await userEvent.click(signInButton)
    },
}

export const TroubleshootingLink: Story = {
    name: "PowerShell Error",
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage:
            "PowerShell is not recognized as an internal or external command. Please check your system configuration.",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)

        await expect(canvas.getByTestId("api-error-box")).toBeInTheDocument()
        await expect(canvas.getByTestId("api-error-box-message")).toHaveTextContent(/PowerShell is not recognized/i)
        await expect(canvas.queryByRole("link", { name: /troubleshooting guide/i })).not.toBeInTheDocument()
    },
}

// Keep this one as it has specific testing logic for request ID
export const ErrorWithRequestId: Story = {
    args: {
        message: createMockMessage(),
        errorType: "error",
        apiRequestFailedMessage: JSON.stringify({
            message: "An unexpected error occurred while processing your request.",
            request_id: "req_detailed_123456",
            providerId: "cline",
        }),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)

        // Verify error message is displayed
        const errorMessage = canvas.getByText(/an unexpected error occurred/i)
        await expect(errorMessage).toBeInTheDocument()

        // Structured metadata renders its label and value in separate definition-list cells.
        await expect(canvas.getByText("Request ID", { exact: true })).toBeInTheDocument()
        await expect(canvas.getByTestId("api-error-box-request-id")).toHaveTextContent("req_detailed_123456")
    },
}
