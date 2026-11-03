import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskRuntimeControls } from "./TaskRuntimeControls"

const mocks = vi.hoisted(() => ({
    state: {
        apiConfiguration: {
            actModeProfileId: "opencode-id",
            planModeProfileId: "opencode-id",
        } as Record<string, unknown>,
        mode: "act" as "act" | "plan",
        taskViewState: { taskId: "task-opencode", phase: "between_turns" },
    },
    profiles: [] as ApiProfile[],
    updateTaskSettings: vi.fn(),
}))

vi.mock("@context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@components/settings/providers/useApiProfiles", () => ({ useApiProfiles: () => ({ profiles: mocks.profiles }) }))
vi.mock("@components/settings/utils/settingsHandlers", () => ({ updateTaskSettings: mocks.updateTaskSettings }))
vi.mock("@components/settings/providers/useProviderModels", () => ({
    useProviderModels: (catalog: string) => ({
        models: {
            remote: {
                id: "remote",
                capabilities: {
                    supportsReasoning: true,
                    thinking:
                        catalog === "opencode-go"
                            ? { supported: true, mode: "effort", effortLevels: ["low", "medium", "high", "xhigh", "max"] }
                            : { supported: true, mode: "budget", minBudget: 1024, maxBudget: 4096 },
                },
            } as ModelInfo,
        },
        defaultModelId: "remote",
    }),
}))

beforeEach(() => {
    mocks.updateTaskSettings.mockReset()
    mocks.state.mode = "act"
    mocks.state.apiConfiguration = { actModeProfileId: "opencode-id", planModeProfileId: "opencode-id" }
    mocks.profiles = [
        ApiProfile.create({
            id: "opencode-id",
            provider: "opencode",
            modelId: "remote",
            opencode: { mode: 2 },
        }),
    ]
})

describe("OpenCode toolbar inheritance", () => {
    it.each([
        "plan",
        "act",
    ] as const)("reads the Go catalog and inherits the Profile default in %s without writing a Task override", (mode) => {
        mocks.state.mode = mode
        render(<TaskRuntimeControls />)
        expect(screen.getByRole("combobox", { name: "Task thinking override" })).toHaveTextContent(/^Xhigh$/)
        expect(mocks.updateTaskSettings).not.toHaveBeenCalled()
        expect(mocks.profiles[0].opencode?.reasoning).toBeUndefined()
    })

    it("follows a Profile edit only while no temporary effort has been selected", () => {
        const profile = mocks.profiles[0]
        profile.opencode!.reasoning = { enableThinking: true, effort: "low" }
        const { rerender } = render(<TaskRuntimeControls />)
        const control = () => screen.getByRole("combobox", { name: "Task thinking override" })
        expect(control()).toHaveTextContent(/^Low$/)
        profile.opencode!.reasoning = { enableThinking: true, effort: "medium" }
        rerender(<TaskRuntimeControls />)
        expect(control()).toHaveTextContent(/^Medium$/)
        mocks.state.apiConfiguration.actModeReasoningOverride = { kind: "effort", effort: "high" }
        rerender(<TaskRuntimeControls />)
        expect(control()).toHaveTextContent(/^High$/)
        profile.opencode!.reasoning = { enableThinking: true, effort: "low" }
        rerender(<TaskRuntimeControls />)
        expect(control()).toHaveTextContent(/^High$/)
        mocks.state.apiConfiguration.actModeReasoningOverride = { kind: "inherit" }
        rerender(<TaskRuntimeControls />)
        expect(control()).toHaveTextContent(/^Low$/)
        expect(mocks.updateTaskSettings).not.toHaveBeenCalled()
    })
})
