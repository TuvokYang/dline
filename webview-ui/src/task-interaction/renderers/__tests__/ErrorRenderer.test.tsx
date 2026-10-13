import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ErrorRenderer } from "../PresentationRenderers"

const auth = vi.hoisted(() => ({ clineUser: null as unknown, useClineAuth: vi.fn() }))

vi.mock("@/context/ClineAuthContext", () => ({
    useClineAuth: auth.useClineAuth,
    useClineSignIn: () => ({ isLoginLoading: false, handleSignIn: vi.fn() }),
}))

vi.mock("@/services/grpc-client", () => ({
    AccountServiceClient: { getRedirectUrl: vi.fn(async () => ({ value: "vscode://dline/callback" })) },
    TaskServiceClient: { askResponse: vi.fn(async () => undefined) },
}))

vi.mock("@/components/chat/SpendLimitError", () => ({
    default: ({ message }: { message?: string }) => <div data-testid="spend-limit-error">{message}</div>,
}))

/** The failure interaction the task presents with Retry, carrying a serialized provider error. */
function failure(error: Record<string, unknown>): UiMessage {
    return { ts: 1, type: "ask", ask: "api_req_failed", text: JSON.stringify(error) }
}

// The interaction that offers Retry rendered only the raw error box, so an
// account limit or a signed-out account read as an opaque failure there while
// the same error in a chat row named what to do.
describe("ErrorRenderer", () => {
    beforeEach(() => {
        auth.clineUser = null
        auth.useClineAuth.mockReset()
        auth.useClineAuth.mockImplementation(() => ({ clineUser: auth.clineUser }))
    })

    // The footer owns Retry for this interaction; the balance card's own legacy
    // Retry would answer it outside the interaction's identity.
    it("names an exhausted balance instead of showing the raw failure, leaving Retry to the footer", async () => {
        render(
            <ErrorRenderer
                message={failure({
                    message: "Insufficient credits",
                    code: "insufficient_credits",
                    providerId: "cline",
                    details: { current_balance: 0, message: "You have run out of credits." },
                })}
            />,
        )

        expect(screen.getByText("You have run out of credits.")).toBeInTheDocument()
        expect(await screen.findByText("Buy Credits")).toBeInTheDocument()
        expect(screen.queryByText("Retry Request")).toBeNull()
        expect(screen.queryByTestId("error-presentation-box")).toBeNull()
    })

    it("names an organization spend limit", () => {
        render(
            <ErrorRenderer
                message={failure({
                    message: "Spend limit exceeded",
                    status: 429,
                    code: "SPEND_LIMIT_EXCEEDED",
                    details: { message: "Your organization reached its monthly budget." },
                })}
            />,
        )

        expect(screen.getByTestId("spend-limit-error")).toHaveTextContent("Your organization reached its monthly budget.")
        expect(screen.queryByTestId("error-presentation-box")).toBeNull()
    })

    it("offers sign-in when the Dline account behind the failure is signed out", () => {
        render(<ErrorRenderer message={failure({ message: "Unauthorized", status: 401, providerId: "cline" })} />)

        expect(screen.getByText(/looks like you're logged out/)).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Sign in to Dline" })).toBeEnabled()
        expect(screen.queryByTestId("error-presentation-box")).toBeNull()
    })

    it("shows the failure itself when the Dline account is signed in", () => {
        auth.clineUser = { uid: "user-1" }

        render(<ErrorRenderer message={failure({ message: "Unauthorized", status: 401, providerId: "cline" })} />)

        expect(screen.getByTestId("error-presentation-box")).toHaveTextContent("Unauthorized")
        expect(screen.queryByRole("button", { name: "Sign in to Dline" })).toBeNull()
    })

    it("renders any other failure in the error box without reading the account", () => {
        render(<ErrorRenderer message={failure({ message: "Connection error.", providerId: "anthropic" })} />)

        expect(screen.getByTestId("error-presentation-box")).toHaveTextContent("Connection error.")
        expect(auth.useClineAuth).not.toHaveBeenCalled()
    })
})
