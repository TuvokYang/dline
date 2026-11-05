import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SettingsView from "./SettingsView"

const mocks = vi.hoisted(() => ({
    save: vi.fn(),
    flushProfiles: vi.fn(),
    flushSettings: vi.fn(),
    flushBackend: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ version: "test", environment: "production" }),
}))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => ({ activeOrganization: null }) }))
vi.mock("@/services/grpc-client", () => ({
    StateServiceClient: { resetState: vi.fn(), flushPendingState: mocks.flushBackend },
}))
vi.mock("./providers/useApiProfiles", () => ({ flushPendingApiProfileWrites: mocks.flushProfiles }))
vi.mock("./utils/settingsHandlers", () => ({ flushPendingSettingsRequests: mocks.flushSettings }))
vi.mock("./sections/ApiConfigurationSection", async () => {
    const { useDebouncedInput } = await import("./utils/useDebouncedInput")
    return {
        default: function EditingSection() {
            const [value, setValue] = useDebouncedInput("before", mocks.save)
            return <input aria-label="Profile setting" onChange={(event) => setValue(event.target.value)} value={value} />
        },
    }
})
vi.mock("./sections/AboutSection", () => ({ default: () => null }))
vi.mock("./sections/BrowserSettingsSection", () => ({ default: () => null }))
vi.mock("./sections/DebugSection", () => ({ default: () => null }))
vi.mock("./sections/FeatureSettingsSection", () => ({ default: () => null }))
vi.mock("./sections/GeneralSettingsSection", () => ({ default: () => null }))
vi.mock("./sections/RemoteConfigSection", () => ({ RemoteConfigSection: () => null }))
vi.mock("./sections/TerminalSettingsSection", () => ({ default: () => null }))

function SettingsSession({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true)
    return open ? (
        <SettingsView
            onDone={() => {
                onClose()
                setOpen(false)
            }}
        />
    ) : (
        <div>Settings closed</div>
    )
}

describe("Settings Done", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        mocks.save.mockReset().mockResolvedValue(undefined)
        mocks.flushProfiles.mockReset().mockResolvedValue(undefined)
        mocks.flushSettings.mockReset().mockResolvedValue(undefined)
        mocks.flushBackend.mockReset().mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it.each(["saved", "pending", "failed"] as const)("closes without saving again: %s", async (state) => {
        if (state === "pending") mocks.save.mockImplementation(() => new Promise<void>(() => {}))
        if (state === "failed") {
            mocks.save.mockRejectedValue(new Error("Profile save failed"))
            vi.spyOn(console, "error").mockImplementation(() => undefined)
        }
        const onClose = vi.fn()
        render(<SettingsSession onClose={onClose} />)
        fireEvent.change(screen.getByLabelText("Profile setting"), { target: { value: "after" } })
        await act(async () => vi.advanceTimersByTimeAsync(100))
        expect(mocks.save).toHaveBeenCalledExactlyOnceWith("after")

        fireEvent.click(screen.getByRole("button", { name: "Done" }))

        expect(onClose).toHaveBeenCalledOnce()
        expect(screen.getByText("Settings closed")).toBeInTheDocument()
        expect(mocks.flushProfiles).not.toHaveBeenCalled()
        expect(mocks.flushSettings).not.toHaveBeenCalled()
        expect(mocks.flushBackend).not.toHaveBeenCalled()
        await act(async () => vi.advanceTimersByTimeAsync(100))
        expect(mocks.save).toHaveBeenCalledTimes(1)
    })

    it("lets the input commit its last draft on close without waiting for that save", async () => {
        mocks.save.mockImplementation(() => new Promise<void>(() => {}))
        const onClose = vi.fn()
        render(<SettingsSession onClose={onClose} />)
        fireEvent.change(screen.getByLabelText("Profile setting"), { target: { value: "last draft" } })
        expect(mocks.save).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole("button", { name: "Done" }))

        expect(onClose).toHaveBeenCalledOnce()
        expect(screen.getByText("Settings closed")).toBeInTheDocument()
        await act(async () => Promise.resolve())
        expect(mocks.save).toHaveBeenCalledExactlyOnceWith("last draft")
        await act(async () => vi.advanceTimersByTimeAsync(200))
        expect(mocks.save).toHaveBeenCalledTimes(1)
        expect(mocks.flushProfiles).not.toHaveBeenCalled()
        expect(mocks.flushBackend).not.toHaveBeenCalled()
    })
})
