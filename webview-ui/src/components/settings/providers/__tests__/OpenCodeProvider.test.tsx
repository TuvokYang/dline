import { ApiProfile } from "@shared/proto/dline/profile"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { OpenCodeMode, OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { OpenCodeProvider } from "../OpenCodeProvider"

vi.mock("../useProviderModelOptions", () => ({
    useProviderModelOptions: () => ({
        models: {
            "budget-model": {
                id: "budget-model",
                apiFormats: [2],
                capabilities: {
                    supportsReasoning: true,
                    thinking: { supported: true, mode: "budget", minBudget: 1024, maxBudget: 3072 },
                },
            },
        },
        defaultModelId: "budget-model",
        options: { "budget-model": "budget-model" },
        refreshRemoteModels: vi.fn(),
    }),
}))
vi.mock("../useProviderModels", () => ({ useProviderModels: () => ({ models: {} }) }))

describe("OpenCodeProvider", () => {
    it("projects the saved reasoning budget through the production wrapper to its control", () => {
        const profile = ApiProfile.create({
            id: "opencode-budget",
            provider: "opencode",
            modelId: "budget-model",
            opencode: OpenCodeProviderConfig.create({
                mode: OpenCodeMode.OPEN_CODE_MODE_GO,
                model: BaseProviderConfig.create({ reasoning: { enableThinking: true, thinkingBudget: 2048 } }),
            }),
        })
        render(
            <ExtensionStateContextProvider>
                <OpenCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={false} />
            </ExtensionStateContextProvider>,
        )

        const control = screen.getByLabelText("Thinking Budget") as HTMLElement & { value?: string }
        expect(control.value).toBe("2048")
    })
})
