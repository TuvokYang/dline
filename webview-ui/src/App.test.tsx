import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    onDidShowAnnouncement: vi.fn(),
    setShouldShowAnnouncement: vi.fn(),
    setShowAnnouncement: vi.fn(),
}))

vi.mock("./context/ClineAuthContext", () => ({
    useClineAuth: () => ({ activeOrganization: undefined, clineUser: undefined, organizations: [] }),
}))

vi.mock("./context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        closeMcpView: vi.fn(),
        didHydrateState: true,
        hideAccount: vi.fn(),
        hideAnnouncement: vi.fn(),
        hideHistory: vi.fn(),
        hideSettings: vi.fn(),
        hideWorktrees: vi.fn(),
        navigateToHistory: vi.fn(),
        setShouldShowAnnouncement: mocks.setShouldShowAnnouncement,
        setShowAnnouncement: mocks.setShowAnnouncement,
        shouldShowAnnouncement: true,
        showAccount: false,
        showAnnouncement: false,
        showHistory: false,
        showMcp: false,
        showSettings: false,
        showWelcome: false,
        showWorktrees: false,
    }),
}))

vi.mock("./services/grpc-client", () => ({
    UiServiceClient: { onDidShowAnnouncement: mocks.onDidShowAnnouncement },
}))

vi.mock("./components/chat/ChatView", () => ({ default: () => <div>Chat</div> }))

import { AppContent } from "./App"

describe("App announcement lifecycle", () => {
    beforeEach(() => {
        mocks.onDidShowAnnouncement.mockReset()
        mocks.setShouldShowAnnouncement.mockReset()
        mocks.setShowAnnouncement.mockReset()
    })

    it("clears the pending announcement before the asynchronous acknowledgement completes", async () => {
        mocks.onDidShowAnnouncement.mockReturnValue(new Promise(() => undefined))

        render(<AppContent />)

        await waitFor(() => expect(mocks.onDidShowAnnouncement).toHaveBeenCalledOnce())
        expect(mocks.setShouldShowAnnouncement).toHaveBeenCalledWith(false)
        expect(mocks.setShowAnnouncement).toHaveBeenCalledWith(true)
    })
})
