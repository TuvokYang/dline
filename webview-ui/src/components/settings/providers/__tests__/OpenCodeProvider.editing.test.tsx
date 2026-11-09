import { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenCodeMode, OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { resolveProfileReasoningConfig } from "@shared/task-reasoning"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContext, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { encodeOpenAIChatReasoning } from "../../../../../../src/core/api/providers/openai/reasoning"
import { OpenCodeProvider } from "../OpenCodeProvider"

const catalogs = vi.hoisted(() => ({
    "opencode-console": { defaultModelId: "console-default", models: {} as Record<string, unknown> },
    "opencode-go": { defaultModelId: "go-default", models: {} as Record<string, unknown> },
}))
vi.mock("../useProviderModels", () => ({
    useProviderModels: (key: keyof typeof catalogs) => ({ ...catalogs[key], loading: false }),
}))
vi.mock("../useProviderModelOptions", () => ({
    useProviderModelOptions: ({ providerId }: { providerId: keyof typeof catalogs }) => ({
        ...catalogs[providerId],
        options: catalogs[providerId].models,
        refreshRemoteModels: vi.fn(),
    }),
}))
vi.mock("../../common/ModelInfoView", () => ({ ModelInfoView: () => null }))
vi.mock("../ProviderUsage", () => ({ ProviderUsage: () => null }))

const budgetModel = ModelInfo.create({
    id: "go-selected",
    name: "Selected Go model",
    apiFormats: [ApiFormat.OPENAI_CHAT],
    capabilities: {
        supportsReasoning: true,
        thinking: { supported: true, mode: "budget", minBudget: 1024, maxBudget: 4096, canDisable: true },
    },
})
beforeEach(() => {
    catalogs["opencode-go"].defaultModelId = "go-default"
    catalogs["opencode-go"].models = {
        "go-selected": budgetModel,
        "go-default": ModelInfo.create({ id: "go-default" }),
    }
    catalogs["opencode-console"].models = { "console-default": ModelInfo.create({ id: "console-default" }) }
})

async function selectControl(label: string, value: string) {
    const control = screen.getByLabelText(label)
    Object.defineProperty(control, "value", { value, writable: true, configurable: true })
    await act(async () => {
        fireEvent(control, new Event("change", { bubbles: true }))
    })
}

function selectPlan(value: string) {
    return selectControl("Plan", value)
}

function Editor({ initial }: { initial: ApiProfile }) {
    const [profile, setProfile] = useState(initial)
    return (
        <ExtensionStateContext.Provider value={{ mode: "act" } as ExtensionStateContextType}>
            <OpenCodeProvider
                onUpdate={(updates) =>
                    setProfile((current) => ApiProfile.fromJSON(ApiProfile.toJSON({ ...current, ...updates })))
                }
                profile={profile}
                showModelOptions={false}
            />
            <output data-testid="saved-profile">{JSON.stringify(ApiProfile.toJSON(profile))}</output>
        </ExtensionStateContext.Provider>
    )
}

function savedProfile(): ApiProfile {
    return ApiProfile.fromJSON(JSON.parse(screen.getByTestId("saved-profile").textContent || "{}"))
}

const plans = [
    ["go", OpenCodeMode.OPEN_CODE_MODE_GO],
    ["go-plus", OpenCodeMode.OPEN_CODE_MODE_GO_PLUS],
    ["go-teams", OpenCodeMode.OPEN_CODE_MODE_GO_TEAMS],
] as const

describe("OpenCode editing round trip", () => {
    it.each(
        plans.flatMap(([from, mode]) =>
            plans.filter(([to]) => to !== from).map(([to, nextMode]) => ({ from, mode, to, nextMode })),
        ),
    )("keeps a non-default Go model when switching $from to $to", async ({ mode, to, nextMode }) => {
        render(
            <Editor
                initial={ApiProfile.create({
                    id: "plan-profile",
                    provider: "opencode",
                    modelId: budgetModel.id,
                    modelInfo: budgetModel,
                    opencode: OpenCodeProviderConfig.create({ mode, capabilities: { contextWindow: 8192 } }),
                })}
            />,
        )

        await selectPlan(to)

        const saved = savedProfile()
        expect(saved.opencode?.mode).toBe(nextMode)
        expect(saved.modelId).toBe("go-selected")
        expect(saved.opencode?.capabilities?.contextWindow).toBe(8192)
        expect(saved.modelInfo?.id).toBe("go-selected")
    })

    it.each([true, false])("uses the target catalog when a Console model is shared=%s", async (shared) => {
        if (shared) catalogs["opencode-go"].models["console-default"] = ModelInfo.create({ id: "console-default" })
        render(
            <Editor
                initial={ApiProfile.create({
                    id: "cross-catalog",
                    provider: "opencode",
                    modelId: "console-default",
                    opencode: OpenCodeProviderConfig.create({ mode: OpenCodeMode.OPEN_CODE_MODE_CONSOLE }),
                })}
            />,
        )
        await selectPlan("go-plus")
        expect(savedProfile().opencode?.mode).toBe(OpenCodeMode.OPEN_CODE_MODE_GO_PLUS)
        expect(savedProfile().modelId).toBe(shared ? "console-default" : "go-default")
    })

    it.each(["", "missing-model"])("clears a missing target model: %s", async (defaultModelId) => {
        catalogs["opencode-go"].models = {}
        catalogs["opencode-go"].defaultModelId = defaultModelId
        render(
            <Editor
                initial={ApiProfile.create({
                    id: "empty-target",
                    provider: "opencode",
                    modelId: "console-default",
                    opencode: OpenCodeProviderConfig.create({ mode: OpenCodeMode.OPEN_CODE_MODE_CONSOLE }),
                })}
            />,
        )
        await selectPlan("go")
        expect(savedProfile().opencode?.mode).toBe(OpenCodeMode.OPEN_CODE_MODE_GO)
        expect(savedProfile().modelId).toBe("")
        expect(savedProfile().modelInfo).toBeUndefined()
    })

    it.each([2048, 1536, undefined, 0, 999999])("round-trips budget Thinking off/on: %s", async (budget) => {
        render(
            <Editor
                initial={ApiProfile.create({
                    id: "budget-profile",
                    provider: "opencode",
                    modelId: budgetModel.id,
                    opencode: OpenCodeProviderConfig.create({
                        mode: OpenCodeMode.OPEN_CODE_MODE_GO,
                        apiFormat: ApiFormat.OPENAI_CHAT,
                        reasoning: { enableThinking: true, thinkingBudget: budget },
                    }),
                })}
            />,
        )

        await act(async () => {
            fireEvent.change(screen.getByLabelText("Enable Thinking"), { target: { checked: false } })
        })
        expect(savedProfile().opencode?.reasoning?.enableThinking).toBe(false)
        expect(savedProfile().opencode?.reasoning?.thinkingBudget).toBe(budget)
        expect(
            encodeOpenAIChatReasoning(
                budgetModel.capabilities,
                resolveProfileReasoningConfig(savedProfile(), budgetModel.capabilities),
            ),
        ).toEqual({ enable_thinking: false })
        await act(async () => {
            fireEvent.change(screen.getByLabelText("Enable Thinking"), { target: { checked: true } })
        })

        const saved = savedProfile()
        const reasoning = resolveProfileReasoningConfig(saved, budgetModel.capabilities)
        const request = encodeOpenAIChatReasoning(budgetModel.capabilities, reasoning)
        const displayed = Number((screen.getByLabelText("Thinking Budget") as HTMLElement & { value: string }).value)
        expect(saved.opencode?.reasoning?.enableThinking).toBe(true)
        expect(displayed).toBe(budget === 2048 || budget === 1536 ? budget : 1024)
        expect(saved.opencode?.reasoning?.thinkingBudget).toBe(displayed)
        expect(request).toEqual({ enable_thinking: true, thinking_budget: displayed })
    })
})
