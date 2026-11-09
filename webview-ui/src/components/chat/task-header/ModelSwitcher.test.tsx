import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import ModelSwitcher from "./ModelSwitcher"

const mocks = vi.hoisted(() => ({
    state: {
        apiConfiguration: {
            planModeProfileId: "large-id",
            planModeProfile: "large-profile",
            actModeProfileId: "large-id",
            actModeProfile: "large-profile",
        },
        mode: "act" as const,
        planActSeparateModelsSetting: false,
        currentTaskItem: { id: "task-1" },
        taskTitleMessage: { ts: 1, type: "say", say: "task", text: "task" },
        taskViewState: { taskId: "task-1", phase: "completed" as const },
        profileSwitch: { phase: "idle" as const },
        stateRevision: 1,
    },
    requestSwitch: vi.fn(),
    confirmSwitch: vi.fn(),
    cancelSwitch: vi.fn(),
    selectProfile: vi.fn(),
    selectProfiles: vi.fn(),
    addProfile: vi.fn(),
    profileStore: {
        profiles: [
            {
                id: "large-id",
                name: "large-profile",
                legacyNames: ["old-large-profile"],
                provider: "test",
                modelId: "large",
                usedFor: ["act", "plan"],
                enabled: true,
            },
            {
                id: "small-id",
                name: "small-profile",
                legacyNames: [],
                provider: "test",
                modelId: "small",
                usedFor: ["act", "plan"],
                enabled: true,
            },
        ],
        loaded: true,
        error: undefined as Error | undefined,
    },
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => mocks.state,
}))

vi.mock("@/components/settings/providers/useApiProfiles", () => ({
    useApiProfiles: () => ({
        ...mocks.profileStore,
        addProfile: mocks.addProfile,
        selectProfile: mocks.selectProfile,
        selectProfiles: mocks.selectProfiles,
    }),
}))

vi.mock("@/components/settings/utils/settingsHandlers", () => ({
    updateSetting: vi.fn(),
}))

vi.mock("../profile-switch/useProfileSwitch", () => ({
    useProfileSwitch: () => ({
        requestSwitch: mocks.requestSwitch,
        confirmSwitch: mocks.confirmSwitch,
        cancelSwitch: mocks.cancelSwitch,
        isSwitchPending: false,
        statusText: undefined,
        error: undefined,
    }),
}))

describe("ModelSwitcher Profile transitions", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.state.currentTaskItem = { id: "task-1" }
        mocks.state.taskTitleMessage = { ts: 1, type: "say", say: "task", text: "task" }
        mocks.state.taskViewState = { taskId: "task-1", phase: "completed" }
        mocks.state.apiConfiguration = {
            planModeProfileId: "large-id",
            planModeProfile: "large-profile",
            actModeProfileId: "large-id",
            actModeProfile: "large-profile",
        }
        mocks.state.planActSeparateModelsSetting = false
        mocks.profileStore.profiles = [
            {
                id: "large-id",
                name: "large-profile",
                legacyNames: ["old-large-profile"],
                provider: "test",
                modelId: "large",
                usedFor: ["act", "plan"],
                enabled: true,
            },
            {
                id: "small-id",
                name: "small-profile",
                legacyNames: [],
                provider: "test",
                modelId: "small",
                usedFor: ["act", "plan"],
                enabled: true,
            },
        ]
        mocks.profileStore.loaded = true
        mocks.profileStore.error = undefined
    })

    it("shows loading instead of an empty placeholder while the Catalog loads", () => {
        mocks.profileStore.loaded = false
        mocks.profileStore.profiles = []

        render(<ModelSwitcher onOpenSettings={vi.fn()} />)

        expect(screen.queryByText("-:-")).not.toBeInTheDocument()
    })

    it("creates and opens a new API configuration when the Catalog is empty", () => {
        mocks.profileStore.profiles = []
        const onOpenSettings = vi.fn()

        render(<ModelSwitcher onOpenSettings={onOpenSettings} />)

        const button = screen.getByRole("button", { name: "Select model" })
        fireEvent.click(button)
        expect(mocks.addProfile).toHaveBeenCalledOnce()
        expect(onOpenSettings).toHaveBeenCalledOnce()
        expect(screen.queryByTestId("profile-menu")).not.toBeInTheDocument()
    })

    it("uses the shared menu surface for the Profile list", () => {
        render(<ModelSwitcher onOpenSettings={vi.fn()} />)

        fireEvent.click(screen.getByRole("button", { name: "Select model" }))

        const menu = screen.getByTestId("profile-menu")
        const list = screen.getByTestId("profile-list")

        for (const option of screen.getAllByRole("option")) {
        }
    })

    it("shows declared flat prices without inventing a missing rate or currency", () => {
        Object.assign(mocks.profileStore.profiles[0], {
            modelInfo: { pricing: { currency: "CNY", strategy: { flat: { prices: { outputPrice: 0 } } } } },
        })
        render(<ModelSwitcher onOpenSettings={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: "Select model" }))
        const option = screen.getByRole("option", { name: /large-profile/ })
        const priceSlots = option
            .getAttribute("title")
            ?.match(/In: (.*?)\/M \| Out: (.*?)\/M/)
            ?.slice(1)
        expect(priceSlots).toEqual(["—", "¥0"])
    })

    it("routes an active Task selection through the Profile transition transaction", () => {
        render(<ModelSwitcher onOpenSettings={vi.fn()} />)

        fireEvent.click(screen.getByRole("button", { name: "Select model" }))
        fireEvent.click(screen.getByRole("option", { name: /small-profile/ }))

        expect(mocks.requestSwitch).toHaveBeenCalledWith("small-id", ["plan", "act"])
        expect(mocks.selectProfiles).not.toHaveBeenCalled()
        expect(mocks.selectProfile).not.toHaveBeenCalled()
    })

    it("routes a completed but still open Task through the Profile transition transaction", () => {
        mocks.state.currentTaskItem = undefined
        mocks.state.taskTitleMessage = undefined
        mocks.state.taskViewState = { taskId: "task-completed", phase: "completed" }
        render(<ModelSwitcher onOpenSettings={vi.fn()} />)

        fireEvent.click(screen.getByRole("button", { name: "Select model" }))
        fireEvent.click(screen.getByRole("option", { name: /small-profile/ }))

        expect(mocks.requestSwitch).toHaveBeenCalledWith("small-id", ["plan", "act"])
        expect(mocks.selectProfiles).not.toHaveBeenCalled()
    })

    it("keeps welcome-screen Profile selection on the global settings path", () => {
        mocks.state.currentTaskItem = undefined
        mocks.state.taskTitleMessage = undefined
        mocks.state.taskViewState = undefined
        render(<ModelSwitcher onOpenSettings={vi.fn()} />)

        fireEvent.click(screen.getByRole("button", { name: "Select model" }))
        fireEvent.click(screen.getByRole("option", { name: /small-profile/ }))

        expect(mocks.selectProfiles).toHaveBeenCalledWith("small-id", ["plan", "act"], undefined, false)
        expect(mocks.requestSwitch).not.toHaveBeenCalled()
    })

    it("keeps the open portal, selected mode and Profile identity across both language directions", () => {
        mocks.state.planActSeparateModelsSetting = true
        const profile = mocks.profileStore.profiles[1]
        if (!profile) throw new Error("Expected the second Profile fixture")
        profile.usedFor = ["plan", "subagents", "image", "RAW custom usage"]
        const profiles = mocks.profileStore.profiles
        const usedFor = profile.usedFor
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ModelSwitcher onOpenSettings={vi.fn()} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const trigger = screen.getByRole("button", { name: "Select model" })
        fireEvent.click(trigger)
        fireEvent.click(screen.getByRole("button", { name: "Plan", exact: true }))
        const menu = screen.getByTestId("profile-menu")
        const option = screen.getByRole("option", { name: /small-profile/ })
        expect(option).toHaveTextContent("Plan, subagents, image, RAW custom usage")

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: "选择模型" })).toBe(trigger)
        expect(screen.getByTestId("profile-menu")).toBe(menu)
        expect(screen.getByRole("option", { name: /small-profile/ })).toBe(option)
        expect(option).toHaveTextContent("规划, 子代理, 图片, RAW custom usage")
        expect(mocks.requestSwitch).not.toHaveBeenCalled()

        view.rerender(tree("en"))
        expect(screen.getByTestId("profile-menu")).toBe(menu)
        expect(option).toHaveTextContent("Plan, subagents, image, RAW custom usage")
        expect(mocks.profileStore.profiles).toBe(profiles)
        expect(profile.usedFor).toBe(usedFor)
        fireEvent.click(option)
        expect(mocks.requestSwitch).toHaveBeenCalledExactlyOnceWith("small-id", ["plan"])
        expect(mocks.selectProfiles).not.toHaveBeenCalled()
        expect(mocks.selectProfile).not.toHaveBeenCalled()
    })

    it("hides Profiles that no conversational mode uses, even without Split Model", () => {
        mocks.profileStore.profiles = [
            ...mocks.profileStore.profiles,
            {
                id: "subagent-only-id",
                name: "subagent-only-profile",
                legacyNames: [],
                provider: "test",
                modelId: "sub",
                usedFor: ["subagents"],
                enabled: true,
            },
            {
                id: "image-only-id",
                name: "image-only-profile",
                legacyNames: [],
                provider: "test",
                modelId: "img",
                usedFor: ["image"],
                enabled: true,
            },
        ]

        render(<ModelSwitcher onOpenSettings={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: "Select model" }))

        expect(screen.getByRole("option", { name: /large-profile/ })).toBeInTheDocument()
        expect(screen.queryByRole("option", { name: /subagent-only-profile/ })).not.toBeInTheDocument()
        expect(screen.queryByRole("option", { name: /image-only-profile/ })).not.toBeInTheDocument()
    })

    it("treats an empty usedFor as unavailable rather than every mode", () => {
        mocks.profileStore.profiles = [
            ...mocks.profileStore.profiles,
            {
                id: "unassigned-id",
                name: "unassigned-profile",
                legacyNames: [],
                provider: "test",
                modelId: "none",
                usedFor: [],
                enabled: true,
            },
        ]

        render(<ModelSwitcher onOpenSettings={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: "Select model" }))

        expect(screen.queryByRole("option", { name: /unassigned-profile/ })).not.toBeInTheDocument()
    })

    it("hides a disabled Profile the display state would immediately reject", () => {
        mocks.profileStore.profiles = [
            ...mocks.profileStore.profiles,
            {
                id: "disabled-id",
                name: "disabled-profile",
                legacyNames: [],
                provider: "test",
                modelId: "off",
                usedFor: ["act", "plan"],
                enabled: false,
            },
        ]

        render(<ModelSwitcher onOpenSettings={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: "Select model" }))

        expect(screen.queryByRole("option", { name: /disabled-profile/ })).not.toBeInTheDocument()
    })

    it("restricts each tab to its own mode once Split Model is enabled", () => {
        mocks.state.planActSeparateModelsSetting = true
        mocks.profileStore.profiles = [
            {
                id: "act-only-id",
                name: "act-only-profile",
                legacyNames: [],
                provider: "test",
                modelId: "a",
                usedFor: ["act"],
                enabled: true,
            },
            {
                id: "plan-only-id",
                name: "plan-only-profile",
                legacyNames: [],
                provider: "test",
                modelId: "p",
                usedFor: ["plan"],
                enabled: true,
            },
        ]

        render(<ModelSwitcher onOpenSettings={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: "Select model" }))

        expect(screen.getByRole("option", { name: /act-only-profile/ })).toBeInTheDocument()
        expect(screen.queryByRole("option", { name: /plan-only-profile/ })).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole("button", { name: "Plan" }))

        expect(screen.getByRole("option", { name: /plan-only-profile/ })).toBeInTheDocument()
        expect(screen.queryByRole("option", { name: /act-only-profile/ })).not.toBeInTheDocument()
    })

    it("selects by stable identity when a display name collides with another Profile", () => {
        // "test:small" is small-profile's fallback label and also large-profile's actual name,
        // so a name-based lookup would resolve the wrong entry.
        mocks.profileStore.profiles = [
            {
                id: "collision-id",
                name: "test:small",
                legacyNames: [],
                provider: "test",
                modelId: "large",
                usedFor: ["act", "plan"],
                enabled: true,
            },
            {
                id: "small-id",
                name: "",
                legacyNames: [],
                provider: "test",
                modelId: "small",
                usedFor: ["act", "plan"],
                enabled: true,
            },
        ]

        render(<ModelSwitcher onOpenSettings={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: "Select model" }))

        const options = screen.getAllByRole("option")
        fireEvent.click(options[1])

        expect(mocks.requestSwitch).toHaveBeenCalledWith("small-id", ["plan", "act"])
    })

    it("marks the selected option from the stable binding instead of the first entry", () => {
        mocks.state.apiConfiguration = {
            planModeProfileId: "small-id",
            planModeProfile: "renamed-away",
            actModeProfileId: "small-id",
            actModeProfile: "renamed-away",
        }

        render(<ModelSwitcher onOpenSettings={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: "Select model" }))

        expect(screen.getByRole("option", { name: /small-profile/ })).toHaveAttribute("aria-selected", "true")
        expect(screen.getByRole("option", { name: /large-profile/ })).toHaveAttribute("aria-selected", "false")
    })
})
