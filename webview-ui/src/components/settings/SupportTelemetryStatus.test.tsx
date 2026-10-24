import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SupportTelemetryStatus } from "./SupportTelemetryStatus"

const mocks = vi.hoisted(() => ({
    getStatus: vi.fn(),
    checkNow: vi.fn(),
    openIssue: vi.fn(),
    deleteAndRevoke: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
    SupportServiceClient: mocks,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({
        children,
        appearance: _appearance,
        ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
        <button type="button" {...props}>
            {children}
        </button>
    ),
}))

const absent = {
    present: false,
    publicCode: "",
    state: "",
    authorizationExpiresAt: 0,
}

const active = {
    present: true,
    publicCode: "SUP-ABCD-1234",
    state: "approved",
    authorizationExpiresAt: 1_700_007_200_000,
    captureExpiresAt: 1_700_000_125_000,
    issue: { owner: "TuvokYang", repo: "Dline", number: 115 },
}

describe("SupportTelemetryStatus", () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
        mocks.getStatus.mockReset().mockResolvedValue(absent)
        mocks.checkNow.mockReset()
        mocks.openIssue.mockReset().mockResolvedValue({})
        mocks.deleteAndRevoke.mockReset().mockResolvedValue({})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("stays hidden when owner-only storage has no active authorization", async () => {
        render(<SupportTelemetryStatus />)

        await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(1))
        expect(screen.queryByTestId("support-telemetry-status")).toBeNull()
    })

    it("projects only the public support identity, state, issue, and countdowns", async () => {
        mocks.getStatus.mockResolvedValue(active)

        render(<SupportTelemetryStatus />)

        expect(await screen.findByTestId("support-public-code")).toHaveTextContent("SUP-ABCD-1234")
        expect(screen.getByTestId("support-state")).toHaveTextContent("Approved and capturing temporary diagnostics")
        expect(screen.getByTestId("support-issue")).toHaveTextContent("TuvokYang/Dline#115")
        expect(screen.getByTestId("support-authorization-countdown")).toHaveTextContent("2h 0m 0s")
        expect(screen.getByTestId("support-capture-countdown")).toHaveTextContent("2m 5s")
    })

    it("refreshes the safe projection and opens only the linked issue", async () => {
        mocks.getStatus.mockResolvedValue(active)
        mocks.checkNow.mockResolvedValue({ ...active, state: "pending_approval", captureExpiresAt: undefined })

        render(<SupportTelemetryStatus />)
        await screen.findByTestId("support-public-code")

        fireEvent.click(screen.getByRole("button", { name: "Check now" }))
        await waitFor(() => expect(mocks.checkNow).toHaveBeenCalledTimes(1))
        expect(screen.getByTestId("support-state")).toHaveTextContent("Waiting for support approval")

        fireEvent.click(screen.getByRole("button", { name: "Open issue" }))
        await waitFor(() => expect(mocks.openIssue).toHaveBeenCalledTimes(1))
    })

    it("requires explicit confirmation before local delete and revoke", async () => {
        mocks.getStatus.mockResolvedValueOnce(active).mockResolvedValueOnce(absent)

        render(<SupportTelemetryStatus />)
        await screen.findByTestId("support-public-code")

        fireEvent.click(screen.getByRole("button", { name: "Delete & Revoke" }))
        expect(mocks.deleteAndRevoke).not.toHaveBeenCalled()
        expect(screen.getByRole("button", { name: "Confirm delete & revoke" })).toBeTruthy()

        fireEvent.click(screen.getByRole("button", { name: "Confirm delete & revoke" }))
        await waitFor(() => expect(mocks.deleteAndRevoke).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(screen.queryByTestId("support-telemetry-status")).toBeNull())
    })
})
