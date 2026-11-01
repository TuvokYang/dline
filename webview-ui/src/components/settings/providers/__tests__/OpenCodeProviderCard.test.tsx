import { ApiFormat, type ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { fireEvent, render, screen } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { OpenCodeProviderCard } from "../OpenCodeProviderCard"

/**
 * The card embeds the shared usage surface, which reads extension state for the
 * Profile Catalog revision. Rendering it outside that provider would exercise a
 * different code path than the settings page does.
 */
function StateWrapper({ children }: PropsWithChildren) {
    return <ExtensionStateContextProvider>{children}</ExtensionStateContextProvider>
}

/**
 * The gateway resells models with different reasoning shapes, so the card's
 * model list and thinking control are both driven by what the catalog declares.
 * These cases pin the two behaviours that a fixed widget would get wrong.
 */

function renderCard(overrides: Partial<React.ComponentProps<typeof OpenCodeProviderCard>> = {}) {
    const props: React.ComponentProps<typeof OpenCodeProviderCard> = {
        apiFormat: ApiFormat.OPENAI_CHAT,
        apiKey: "",
        modelId: "claude-sonnet-5-5",
        plan: "balance",
        profileId: "profile-1",
        models: ["claude-sonnet-5-5", "kimi-k3"],
        onApiFormatChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onModelChange: vi.fn(),
        onPlanChange: vi.fn(),
        ...overrides,
    }
    return render(<OpenCodeProviderCard {...props} />, { wrapper: StateWrapper })
}

describe("OpenCodeProviderCard", () => {
    it("offers a thinking level control only for a model that declares effort levels", () => {
        const effort: ModelCapabilities = {
            supportsReasoning: true,
            thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"], defaultEffort: "high" },
        }
        const { unmount } = renderCard({ capabilities: effort, enableThinking: true })

        expect(screen.getByText("Thinking Level")).toBeTruthy()
        expect(screen.queryByLabelText("Thinking Budget")).toBeNull()
        unmount()

        // A model that declares nothing must not offer a preference the gateway
        // cannot honour.
        renderCard({ capabilities: { supportsReasoning: false } })
        expect(screen.queryByText("Thinking Level")).toBeNull()
        expect(screen.queryByLabelText("Thinking Budget")).toBeNull()
        expect(screen.queryByText("Enable Thinking")).toBeNull()
    })

    it("asks the gateway for its current models when the model list receives focus", () => {
        // A source registered but never reached from the card passes every
        // source-level test while the user can never refresh. Focus is the only
        // trigger the other listing providers bind, so it is the contract here.
        const onRefreshModels = vi.fn()
        renderCard({ onRefreshModels })

        fireEvent.focus(screen.getByLabelText("Model"))

        expect(onRefreshModels).toHaveBeenCalledTimes(1)
    })

    it("shows the stored budget as selected and falls back to a declared value when it is not offered", () => {
        const budget: ModelCapabilities = {
            supportsReasoning: true,
            thinking: { supported: true, mode: "budget", minBudget: 1_024, maxBudget: 3_072 },
        }
        const { unmount } = renderCard({ capabilities: budget, enableThinking: true, thinkingBudget: 2_048 })
        const control = screen.getByLabelText("Thinking Budget") as HTMLElement & { value?: string }
        expect(control.value).toBe("2048")
        unmount()

        // A stored budget the model does not offer still renders a legal value
        // rather than an empty selection.
        renderCard({ capabilities: budget, enableThinking: true, thinkingBudget: 999 })
        const fallback = screen.getByLabelText("Thinking Budget") as HTMLElement & { value?: string }
        expect(fallback.value).toBe("1024")
    })
})
