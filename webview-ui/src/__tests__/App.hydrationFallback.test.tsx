import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A panel that renders nothing is indistinguishable from a broken extension.
 *
 * The webview used to return `null` until the first state payload arrived, so
 * a failed subscription, a stream that closed early and a merely slow start
 * all produced the same blank view — with the only trace in a console the
 * reporting user cannot be asked to open.
 *
 * These tests pin that each of those states renders something, that the
 * failure says why, and that the retry is wired to an actual re-subscription.
 */

const mocks = vi.hoisted(() => ({
    onDidShowAnnouncement: vi.fn(),
    retryHydration: vi.fn(),
    state: {
        didHydrateState: false,
        hydration: { status: "pending" } as { status: string; reason?: string },
    },
}))

vi.mock("../context/ClineAuthContext", () => ({
    useClineAuth: () => ({ activeOrganization: undefined, clineUser: undefined, organizations: [] }),
}))

vi.mock("../context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        closeMcpView: vi.fn(),
        didHydrateState: mocks.state.didHydrateState,
        hydration: mocks.state.hydration,
        retryHydration: mocks.retryHydration,
        hideAccount: vi.fn(),
        hideAnnouncement: vi.fn(),
        hideHistory: vi.fn(),
        hideSettings: vi.fn(),
        hideWorktrees: vi.fn(),
        navigateToHistory: vi.fn(),
        setShouldShowAnnouncement: vi.fn(),
        setShowAnnouncement: vi.fn(),
        shouldShowAnnouncement: false,
        showAccount: false,
        showAnnouncement: false,
        showHistory: false,
        showMcp: false,
        showSettings: false,
        showWelcome: false,
        showWorktrees: false,
    }),
}))

vi.mock("../services/grpc-client", () => ({
    UiServiceClient: { onDidShowAnnouncement: mocks.onDidShowAnnouncement },
}))

vi.mock("../components/chat/ChatView", () => ({ default: () => <div>Chat</div> }))

import { AppContent } from "../App"
import { HydrationPending } from "../components/common/HydrationGate"

describe("webview hydration fallback", () => {
    beforeEach(() => {
        mocks.retryHydration.mockReset()
        mocks.state.didHydrateState = false
        mocks.state.hydration = { status: "pending" }
    })

    it("renders a visible loading state instead of a blank panel", () => {
        const { container } = render(<AppContent />)

        expect(screen.getByTestId("hydration-pending")).toBeTruthy()
        expect(container.textContent?.trim().length).toBeGreaterThan(0)
    })

    /**
     * The reason has to reach the screen. A user reporting a blank panel cannot
     * be asked to open developer tools, which is where this previously stopped.
     */
    it("renders the failure reason when the state subscription fails", () => {
        mocks.state.hydration = { status: "failed", reason: "stream closed unexpectedly" }

        render(<AppContent />)

        expect(screen.getByTestId("hydration-failed")).toBeTruthy()
        expect(screen.getByTestId("hydration-failed-reason").textContent).toContain("stream closed unexpectedly")
    })

    it("invokes retry when the user asks to reconnect", async () => {
        mocks.state.hydration = { status: "failed", reason: "stream closed unexpectedly" }

        render(<AppContent />)
        await userEvent.click(screen.getByTestId("hydration-retry"))

        expect(mocks.retryHydration).toHaveBeenCalledTimes(1)
    })

    it("renders the application once hydration completes", () => {
        mocks.state.didHydrateState = true
        mocks.state.hydration = { status: "ready" }

        render(<AppContent />)

        expect(screen.queryByTestId("hydration-pending")).toBeNull()
        expect(screen.queryByTestId("hydration-failed")).toBeNull()
        expect(screen.getByText("Chat")).toBeTruthy()
    })

    /**
     * Callers that predate the hydration field must keep working. Treating a
     * missing status as a failure would turn a stale mock — or an older webview
     * bundle — into a permanent error screen.
     */
    it("falls back to the loading state when hydration status is absent", () => {
        mocks.state.hydration = undefined as never

        render(<AppContent />)

        expect(screen.getByTestId("hydration-pending")).toBeTruthy()
    })
})

describe("slow hydration escalation", () => {
    /**
     * A slow start and a dead subscription look identical at first. The copy
     * escalates rather than switching to a failure, because claiming failure
     * while a payload is still in flight would be its own defect.
     */
    it("escalates the message once hydration exceeds the expected window", () => {
        vi.useFakeTimers()
        try {
            render(<HydrationPending slowThresholdMs={5000} />)

            expect(screen.queryByTestId("hydration-pending-slow")).toBeNull()

            act(() => {
                vi.advanceTimersByTime(5000)
            })

            expect(screen.getByTestId("hydration-pending-slow")).toBeTruthy()
            // Still loading, not failed: the payload may yet arrive.
            expect(screen.getByTestId("hydration-pending")).toBeTruthy()
        } finally {
            vi.useRealTimers()
        }
    })
})
