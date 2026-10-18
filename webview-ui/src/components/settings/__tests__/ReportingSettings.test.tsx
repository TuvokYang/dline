import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AboutSection from "../sections/AboutSection"
import GeneralSettingsSection from "../sections/GeneralSettingsSection"

/**
 * Where the reporting consents live, and that they stay independent.
 *
 * The checkboxes and the diagnostic bundle export describe the same subject:
 * what Dline is allowed to record about a session. Splitting them across two
 * settings tabs meant a user who wanted to attach a bundle to a bug report had
 * to find the switch somewhere else first. These tests pin the placement so a
 * later edit cannot silently move a consent back out of About.
 */

const USAGE_CHECKBOX = "usage-reporting-setting-checkbox"
const ERROR_CHECKBOX = "error-reporting-setting-checkbox"

const mocks = vi.hoisted(() => ({
    updateSetting: vi.fn(),
    state: {
        usageReportingSetting: "unset" as string,
        errorReportingSetting: "unset" as string,
        remoteConfigSettings: undefined as unknown,
        usageReportingConfirmationPending: false as boolean,
    },
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => mocks.state,
}))

vi.mock("../utils/settingsHandlers", () => ({
    updateSetting: mocks.updateSetting,
}))

vi.mock("@/services/grpc-client", () => ({
    StateServiceClient: { exportRuntimeTelemetryBundle: vi.fn() },
}))

const renderSectionHeader = (tabId: string) => <div>{tabId}</div>

describe("reporting consent placement", () => {
    beforeEach(() => {
        mocks.updateSetting.mockClear()
        mocks.state.usageReportingSetting = "unset"
        mocks.state.errorReportingSetting = "unset"
        mocks.state.remoteConfigSettings = undefined
        mocks.state.usageReportingConfirmationPending = false
    })

    it("asks an earlier opt-in to confirm remote usage and re-enables reporting on confirmation", () => {
        mocks.state.usageReportingSetting = "enabled"
        mocks.state.usageReportingConfirmationPending = true
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        fireEvent.click(screen.getByText("Confirm"))

        expect(mocks.updateSetting).toHaveBeenCalledWith("usageReportingSetting", "enabled")
    })

    it("does not ask for confirmation once the current disclosure is confirmed", () => {
        mocks.state.usageReportingSetting = "enabled"
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        expect(screen.queryByTestId("usage-reporting-confirmation")).toBeNull()
    })

    it("offers both consents next to the diagnostics export once error reporting is on", () => {
        mocks.state.errorReportingSetting = "enabled"
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        expect(screen.getByTestId(USAGE_CHECKBOX)).toBeTruthy()
        expect(screen.getByTestId(ERROR_CHECKBOX)).toBeTruthy()
        expect(screen.getByText("Export diagnostic bundle")).toBeTruthy()
    })

    /**
     * Runtime diagnostics follow the error consent and start only on an explicit
     * "enabled". While that consent is undecided or refused nothing is recorded,
     * so an export would have no session to write and could only fail. Showing it
     * anyway would advertise diagnostics the extension is not permitted to collect.
     */
    it.each(["unset", "disabled"])("hides the diagnostics export while error consent is %s", (setting) => {
        mocks.state.errorReportingSetting = setting
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        expect(screen.queryByText("Export diagnostic bundle")).toBeNull()
        expect(screen.queryByText("Diagnostics")).toBeNull()
        // The consent itself must remain reachable, or the user could never
        // turn diagnostics back on.
        expect(screen.getByTestId(ERROR_CHECKBOX)).toBeTruthy()
    })

    it("does not let the usage consent stand in for the error one", () => {
        // The two were a single switch once; agreeing to product analytics must
        // not silently start crash reporting or the diagnostics recorder.
        mocks.state.usageReportingSetting = "enabled"
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        expect(screen.queryByText("Export diagnostic bundle")).toBeNull()
        expect((screen.getByTestId(USAGE_CHECKBOX) as HTMLInputElement).checked).toBe(true)
        expect((screen.getByTestId(ERROR_CHECKBOX) as HTMLInputElement).checked).toBe(false)
    })

    it("treats an undecided consent as not granted", () => {
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        expect((screen.getByTestId(USAGE_CHECKBOX) as HTMLInputElement).checked).toBe(false)
        expect((screen.getByTestId(ERROR_CHECKBOX) as HTMLInputElement).checked).toBe(false)
    })

    it("persists each choice under its own key", () => {
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        fireEvent.click(screen.getByTestId(USAGE_CHECKBOX))
        expect(mocks.updateSetting).toHaveBeenCalledWith("usageReportingSetting", "enabled")

        fireEvent.click(screen.getByTestId(ERROR_CHECKBOX))
        expect(mocks.updateSetting).toHaveBeenCalledWith("errorReportingSetting", "enabled")
    })

    it("locks a consent when an organization pins it off", () => {
        const { unmount } = render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)
        // The unlocked render is the control: without it, a checkbox that is
        // never disabled would still satisfy the assertion below.
        expect((screen.getByTestId(USAGE_CHECKBOX) as HTMLInputElement).disabled).toBe(false)
        unmount()

        mocks.state.usageReportingSetting = "disabled"
        mocks.state.errorReportingSetting = "disabled"
        mocks.state.remoteConfigSettings = { usageReportingSetting: "disabled", errorReportingSetting: "disabled" }
        render(<AboutSection renderSectionHeader={renderSectionHeader} version="1.2.3" />)

        expect((screen.getByTestId(USAGE_CHECKBOX) as HTMLInputElement).disabled).toBe(true)
        expect((screen.getByTestId(ERROR_CHECKBOX) as HTMLInputElement).disabled).toBe(true)
    })

    it("no longer duplicates the consent in general settings", () => {
        render(<GeneralSettingsSection renderSectionHeader={renderSectionHeader} />)

        expect(screen.queryByTestId(USAGE_CHECKBOX)).toBeNull()
        expect(screen.queryByTestId(ERROR_CHECKBOX)).toBeNull()
    })
})
