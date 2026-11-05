import { ApiProfile } from "@shared/proto/dline/profile"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { ExtensionStateContext, type ExtensionStateContextType } from "../../../context/ExtensionStateContext"
import ApiConfigurationSection from "./ApiConfigurationSection"

const mocks = vi.hoisted(() => ({ getApiProfiles: vi.fn(), updateApiProfiles: vi.fn() }))
vi.mock("../../../services/grpc-client", () => ({
    FileServiceClient: mocks,
    StateServiceClient: { requestProfileSwitch: vi.fn() },
}))
vi.mock("../providers/useImageGenerationProfiles", () => ({
    useImageGenerationProfiles: () => ({ profiles: [], loaded: true }),
}))
vi.mock("../providers/ImageGenerationProfileList", () => ({ ImageGenerationProfileList: () => null }))
vi.mock("../providers/ProviderProfileList", () => ({
    default: ({
        profiles,
        onUpdateProfile,
    }: {
        profiles: ApiProfile[]
        onUpdateProfile: (id: string, patch: Partial<ApiProfile>) => void
    }) =>
        profiles.map((profile) => (
            <input
                aria-label="Profile name"
                key={profile.id}
                onChange={(event) => onUpdateProfile(profile.id, { name: event.target.value })}
                value={profile.name}
            />
        )),
}))

beforeEach(() => {
    mocks.getApiProfiles.mockReset().mockResolvedValue({
        profiles: [ApiProfile.create({ id: "editable", name: "Before" })],
    })
    mocks.updateApiProfiles.mockReset().mockRejectedValueOnce(new Error("Write failed")).mockResolvedValue({})
})

it("keeps the editor mounted while a failed save falls back and the next edit can save", async () => {
    render(
        <ExtensionStateContext.Provider value={{ mode: "act", profileCatalogRevision: 1 } as ExtensionStateContextType}>
            <ApiConfigurationSection />
        </ExtensionStateContext.Provider>,
    )
    const input = await screen.findByRole("textbox", { name: "Profile name" })
    fireEvent.change(input, { target: { value: "Unsaved draft" } })
    await screen.findByRole("alert")
    expect(screen.getByRole("textbox", { name: "Profile name" })).toBe(input)
    await waitFor(() => expect(input).toHaveValue("Before"))
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: "Saved edit" } })
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(input).toHaveValue("Saved edit")
    expect(mocks.updateApiProfiles).toHaveBeenCalledTimes(2)
    expect(mocks.updateApiProfiles.mock.calls[1][0].profiles[0].name).toBe("Saved edit")
})
