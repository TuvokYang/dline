import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ErrorRenderer } from "../PresentationRenderers"

const auth = vi.hoisted(() => ({ useClineAuth: vi.fn() }))
const accountClient = vi.hoisted(() => ({ getRedirectUrl: vi.fn() }))

vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: auth.useClineAuth }))

vi.mock("@/services/grpc-client", () => ({
    AccountServiceClient: accountClient,
    TaskServiceClient: { askResponse: vi.fn(async () => undefined) },
}))

vi.mock("@/components/chat/SpendLimitError", () => ({
    default: ({ message }: { message?: string }) => <div data-testid="spend-limit-error">{message}</div>,
}))

/** The failure interaction the task presents with Retry, carrying a serialized provider error. */
function failure(error: Record<string, unknown>): UiMessage {
    return { ts: 1, type: "ask", ask: "api_req_failed", text: JSON.stringify(error) }
}

// The interaction that offers Retry renders the same provider-specific failure
// content as the corresponding chat row.
describe("ErrorRenderer", () => {
    beforeEach(() => {
        auth.useClineAuth.mockReset()
        auth.useClineAuth.mockReturnValue({ activeOrganization: undefined })
        accountClient.getRedirectUrl.mockReset()
        accountClient.getRedirectUrl.mockResolvedValue({ value: "vscode://dline/callback" })
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
        expect(auth.useClineAuth).not.toHaveBeenCalled()
        expect(accountClient.getRedirectUrl).not.toHaveBeenCalled()
    })

    it("keeps a balance failure without a provider identity on the Dline Account path", async () => {
        render(
            <ErrorRenderer
                message={failure({
                    message: "Insufficient credits",
                    code: "insufficient_credits",
                    details: { current_balance: 0, message: "Your Dline Account balance is empty." },
                })}
            />,
        )

        expect(auth.useClineAuth).toHaveBeenCalledOnce()
        await waitFor(() => expect(accountClient.getRedirectUrl).toHaveBeenCalledOnce())
        expect(await screen.findByText("Buy Credits")).toBeInTheDocument()
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

    it("shows a Cline Provider authentication failure without entering Dline Account", () => {
        render(<ErrorRenderer message={failure({ message: "Unauthorized", status: 401, providerId: "cline" })} />)

        expect(screen.getByTestId("error-presentation-box")).toHaveTextContent("Unauthorized")
        expect(screen.queryByRole("button", { name: "Sign in to Dline" })).toBeNull()
        expect(auth.useClineAuth).not.toHaveBeenCalled()
    })

    it("renders any other failure in the error box without reading the account", () => {
        render(<ErrorRenderer message={failure({ message: "Connection error.", providerId: "anthropic" })} />)

        expect(screen.getByTestId("error-presentation-box")).toHaveTextContent("Connection error.")
        expect(auth.useClineAuth).not.toHaveBeenCalled()
    })
})
