import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SupportTelemetryStatus } from "./SupportTelemetryStatus"

const mocks = vi.hoisted(() => ({
    getStatus: vi.fn(),
    checkNow: vi.fn(),
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
    issueState: "",
}

const active = {
    present: true,
    publicCode: "DLN-BNKP-5RJG-NE6R-Y290",
    state: "approved",
    authorizationExpiresAt: 1_700_007_200_000,
    captureExpiresAt: 1_700_000_125_000,
    issueState: "open",
    resolution: { state: "investigating" },
}

describe("SupportTelemetryStatus", () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
        mocks.getStatus.mockReset().mockResolvedValue(absent)
        mocks.checkNow.mockReset()
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

    it("projects the public code, server-reported issue state and resolution, and countdowns", async () => {
        mocks.getStatus.mockResolvedValue(active)

        render(<SupportTelemetryStatus />)

        expect(await screen.findByTestId("support-public-code")).toHaveTextContent("DLN-BNKP-5RJG-NE6R-Y290")
        expect(screen.getByTestId("support-state")).toHaveTextContent("Approved and capturing temporary diagnostics")
        expect(screen.getByTestId("support-issue")).toHaveTextContent("Open")
        expect(screen.getByTestId("support-resolution")).toHaveTextContent("Investigating")
        expect(screen.queryByTestId("support-resolution-summary")).toBeNull()
        expect(screen.getByTestId("support-authorization-countdown")).toHaveTextContent("2h 0m 0s")
        expect(screen.getByTestId("support-capture-countdown")).toHaveTextContent("2m 5s")
        // OTel never returns the Issue identity, so there is nothing to open.
        expect(screen.queryByRole("button", { name: "Open issue" })).toBeNull()
    })

    it("refreshes the projection with the resolution the server reports", async () => {
        mocks.getStatus.mockResolvedValue(active)
        mocks.checkNow.mockResolvedValue({
            ...active,
            state: "revoked",
            captureExpiresAt: undefined,
            issueState: "closed",
            resolution: { state: "fixed", fixedInVersion: "0.12.1", summary: "Retry now keeps the provider identity." },
        })

        render(<SupportTelemetryStatus />)
        await screen.findByTestId("support-public-code")

        fireEvent.click(screen.getByRole("button", { name: "Check now" }))
        await waitFor(() => expect(mocks.checkNow).toHaveBeenCalledTimes(1))
        expect(screen.getByTestId("support-state")).toHaveTextContent("Revoked")
        expect(screen.getByTestId("support-issue")).toHaveTextContent("Closed")
        expect(screen.getByTestId("support-resolution")).toHaveTextContent("Fixed in 0.12.1")
        expect(screen.getByTestId("support-resolution-summary")).toHaveTextContent("Retry now keeps the provider identity.")
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
