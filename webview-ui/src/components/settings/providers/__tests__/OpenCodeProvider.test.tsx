// @vitest-environment jsdom
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { OpenCodeMode, OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { OpenCodeProvider } from "../OpenCodeProvider"

/**
 * A catalog entry as the vendor listing describes it, including the limits the
 * settings page has to show and let the user lower.
 */
const listedModel = {
    id: "listed-model",
    apiFormats: [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT],
    capabilities: {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        supportsPromptCache: true,
        supportsReasoning: true,
        thinking: { supported: true, mode: "budget", minBudget: 1024, maxBudget: 3072 },
    },
}

const modelCatalog = {
    models: { "listed-model": listedModel } as Record<string, unknown>,
    defaultModelId: "listed-model",
    // The real contract is `Record<string, ModelInfo>`: `useProviderModelOptions`
    // merges the registry catalog into the picker options. A bare string here let
    // the wrapper read a non-object as the metadata baseline, which no production
    // path produces.
    options: { "listed-model": listedModel } as Record<string, unknown>,
    refreshRemoteModels: vi.fn(),
}

vi.mock("../useProviderModelOptions", () => ({
    useProviderModelOptions: () => modelCatalog,
}))
vi.mock("../useProviderModels", () => ({ useProviderModels: () => ({ models: {} }) }))

/**
 * Capture the props the shared editor receives.
 *
 * `ModelConfiguration` owns its own behaviour and is covered where it lives.
 * What this wrapper owns is which values it hands over: the catalog entry as the
 * baseline and only the user's stored limits as the override.
 */
const configurationProps: Array<Record<string, unknown>> = []
vi.mock("../../common/ModelConfiguration", () => ({
    ModelConfiguration: (props: Record<string, unknown>) => {
        configurationProps.push(props)
        return null
    },
}))

describe("OpenCodeProvider", () => {
    it("projects the saved reasoning budget through the production wrapper to its control", () => {
        const profile = ApiProfile.create({
            id: "opencode-budget",
            provider: "opencode",
            modelId: "listed-model",
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

    it("starts a Profile without a stored protocol on the gateway's own OpenAI protocol", () => {
        const profile = ApiProfile.create({
            id: "opencode-default-format",
            provider: "opencode",
            opencode: OpenCodeProviderConfig.create(),
        })
        render(
            <ExtensionStateContextProvider>
                <OpenCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={false} />
            </ExtensionStateContextProvider>,
        )

        // The catalog publishes Responses first, and the gateway serves it as the
        // native OpenAI protocol, so an unset Profile must not fall back to Chat.
        expect(screen.getByRole("combobox", { name: "API Format" })).toHaveValue(String(ApiFormat.OPENAI_RESPONSES))
    })

    it("hands the listed limits over as the baseline instead of as an override", () => {
        configurationProps.length = 0
        const profile = ApiProfile.create({
            id: "opencode-limits",
            provider: "opencode",
            modelId: "listed-model",
            opencode: OpenCodeProviderConfig.create({ model: BaseProviderConfig.create() }),
        })
        render(
            <ExtensionStateContextProvider>
                <OpenCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />
            </ExtensionStateContextProvider>,
        )

        const props = configurationProps.at(-1)
        expect(props?.fields).to.deep.equal({ capabilities: ["contextWindow", "maxTokens"] })
        expect((props?.defaults as { capabilities?: { contextWindow?: number } })?.capabilities?.contextWindow).to.equal(
            1_000_000,
        )
        // Opening the panel must not turn the vendor's numbers into a profile
        // override, so the override side starts empty.
        expect(props?.capabilities).to.equal(undefined)
    })

    it("keeps only the edited limit and clears a limit the user emptied", () => {
        configurationProps.length = 0
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            id: "opencode-cleared-limit",
            provider: "opencode",
            modelId: "listed-model",
            opencode: OpenCodeProviderConfig.create({
                model: BaseProviderConfig.create({ capabilities: { contextWindow: 262_144, maxTokens: 64_000 } }),
            }),
        })
        render(
            <ExtensionStateContextProvider>
                <OpenCodeProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />
            </ExtensionStateContextProvider>,
        )

        const props = configurationProps.at(-1) as {
            onCapabilitiesUpdate: (updates: Record<string, unknown>) => void
        }
        // A cleared number input reports 0; storing that would pin the window at
        // zero, so the key has to be removed while the untouched limit survives.
        props.onCapabilitiesUpdate({ contextWindow: 0 })

        const updated = onUpdate.mock.calls.at(-1)?.[0] as {
            opencode?: { capabilities?: Record<string, unknown> }
        }
        const capabilities = updated.opencode?.capabilities
        expect(capabilities).not.toHaveProperty("contextWindow")
        expect(capabilities?.maxTokens).to.equal(64_000)
    })
})
