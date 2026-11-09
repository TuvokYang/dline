import type { ExtensionState } from "@shared/ExtensionMessage"
import { UpdateSettingsRequest } from "@shared/proto/dline/state"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import FeatureSettingsSection from "../sections/FeatureSettingsSection"

const subscriptions = vi.hoisted(() => ({ state: undefined as undefined | { onResponse: (r: { stateJson: string }) => void } }))
vi.mock("@/services/grpc-client", () => {
    const stream = () => () => {}
    const pending = () => new Promise(() => {})
    return {
        StateServiceClient: {
            subscribeToState: (_r: unknown, handlers: typeof subscriptions.state) => {
                subscriptions.state = handlers
                return () => {}
            },
            updateSettings: vi.fn(async () => ({})),
            getLatestState: pending,
            getAvailableTerminalProfiles: pending,
        },
        UiServiceClient: {
            initializeWebview: pending,
            subscribeToPartialMessage: stream,
            subscribeToTheme: stream,
            subscribeToMcpButtonClicked: stream,
            subscribeToHistoryButtonClicked: stream,
            subscribeToChatButtonClicked: stream,
            subscribeToAccountButtonClicked: stream,
            subscribeToSettingsButtonClicked: stream,
            subscribeToWorktreesButtonClicked: stream,
            subscribeToFocusChatInput: stream,
            subscribeToRelinquishControl: stream,
            subscribeToAddToInput: stream,
        },
        ModelsServiceClient: {
            subscribeToOpenRouterModels: stream,
            subscribeToLiteLlmModels: stream,
            refreshOpenRouterModelsRpc: pending,
            refreshHicapModels: pending,
            refreshLiteLlmModelsRpc: pending,
            refreshVercelAiGatewayModelsRpc: pending,
            refreshClineModelsRpc: pending,
        },
        McpServiceClient: { subscribeToMcpServers: stream, subscribeToMcpMarketplaceCatalog: stream },
        FileServiceClient: { subscribeToWorkspaceUpdates: stream },
        TaskServiceClient: { fetchMessage: pending },
        AccountServiceClient: {},
        WorktreeServiceClient: {},
    }
})

let latest: ExtensionState
function Probe() {
    latest = useExtensionState()
    return null
}
function mount() {
    return render(
        <ExtensionStateContextProvider>
            <Probe />
            <FeatureSettingsSection renderSectionHeader={() => null} />
        </ExtensionStateContextProvider>,
    )
}
function publish(fields: Partial<ExtensionState>) {
    act(() => {
        subscriptions.state!.onResponse({
            stateJson: JSON.stringify({
                ...latest,
                welcomeViewCompleted: true,
                stateRevision: (latest.stateRevision ?? 0) + 1,
                ...fields,
            }),
        })
    })
}
beforeEach(() => {
    vi.clearAllMocks()
    subscriptions.state = undefined
    vi.mocked(StateServiceClient.updateSettings).mockResolvedValue({})
})

// These tests cross the production mount and context subscription. A private
// preference cache, optimistic setting, wrong key or missed gate fails them.
describe("Away settings production mount", () => {
    it("defaults both preferences off and hides while the backend gate is off", () => {
        mount()
        expect(latest.awayModeEnabled).toBe(false)
        expect(latest.autoAwayModeEnabled).toBe(false)
        expect(screen.queryByRole("switch", { name: "Enable Away Mode" })).toBeNull()
        publish({ awayModeGateEnabled: false, awayModeEnabled: true, autoAwayModeEnabled: true })
        expect(screen.queryByRole("switch", { name: "Enable Away Mode" })).toBeNull()
        expect(StateServiceClient.updateSettings).not.toHaveBeenCalled()
    })

    it("keeps the automatic preference checked but disabled when the master is off, including gate hide/show", () => {
        const rendered = mount()
        publish({ awayModeGateEnabled: true, awayModeEnabled: false, autoAwayModeEnabled: true })
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).toBeDisabled()
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).toHaveAttribute("aria-checked", "true")
        publish({ awayModeGateEnabled: false })
        publish({ awayModeGateEnabled: true, awayModeEnabled: true })
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).not.toBeDisabled()
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).toHaveAttribute("aria-checked", "true")
        expect(StateServiceClient.updateSettings).not.toHaveBeenCalled()
        rendered.unmount()
        mount()
        expect(latest.awayModeEnabled).toBe(false)
        expect(latest.autoAwayModeEnabled).toBe(false)
    })

    it("sends typed preference writes, waits for projection, and preserves the other preference", async () => {
        mount()
        publish({ awayModeGateEnabled: true, awayModeEnabled: true, autoAwayModeEnabled: true })
        fireEvent.click(screen.getByRole("switch", { name: "Enable Away Mode" }))
        await waitFor(() => expect(StateServiceClient.updateSettings).toHaveBeenCalledTimes(1))
        const wire = UpdateSettingsRequest.decode(
            UpdateSettingsRequest.encode(vi.mocked(StateServiceClient.updateSettings).mock.calls[0][0]).finish(),
        )
        expect(wire.awayModeEnabled).toBe(false)
        expect(wire.autoAwayModeEnabled).toBeUndefined()
        expect(screen.getByRole("switch", { name: "Enable Away Mode" })).toHaveAttribute("aria-checked", "true")
        publish({ awayModeEnabled: false })
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).toHaveAttribute("aria-checked", "true")
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).toBeDisabled()
    })

    it("shows a failed update without adopting it, permits retry, and sends the automatic key independently", async () => {
        mount()
        publish({ awayModeGateEnabled: true, awayModeEnabled: true, autoAwayModeEnabled: false })
        vi.mocked(StateServiceClient.updateSettings).mockRejectedValueOnce(new Error("Settings unavailable"))
        fireEvent.click(screen.getByRole("switch", { name: "Automatic Away Mode" }))
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).toHaveAttribute("aria-checked", "false")
        fireEvent.click(screen.getByRole("switch", { name: "Automatic Away Mode" }))
        await waitFor(() => expect(StateServiceClient.updateSettings).toHaveBeenCalledTimes(2))
        const wire = UpdateSettingsRequest.decode(
            UpdateSettingsRequest.encode(vi.mocked(StateServiceClient.updateSettings).mock.calls[1][0]).finish(),
        )
        expect(wire.autoAwayModeEnabled).toBe(true)
        expect(wire.awayModeEnabled).toBeUndefined()
        publish({ autoAwayModeEnabled: true })
        expect(screen.getByRole("switch", { name: "Automatic Away Mode" })).toHaveAttribute("aria-checked", "true")
    })
})
