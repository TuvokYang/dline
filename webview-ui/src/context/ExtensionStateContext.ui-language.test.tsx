import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const subscription = vi.hoisted(() => ({
    state: undefined as
        | undefined
        | { onResponse: (response: { stateJson: string }) => void; onError: (error: unknown) => void; onComplete: () => void },
}))
vi.mock("../services/grpc-client", () => {
    const stream = () => () => {}
    return {
        StateServiceClient: {
            subscribeToState: vi.fn((_request: unknown, handlers: typeof subscription.state) => {
                subscription.state = handlers
                return () => {}
            }),
            getAvailableTerminalProfiles: vi.fn(async () => ({ profiles: [] })),
        },
        TaskServiceClient: {
            fetchMessage: vi.fn(async () => ({ messages: [], startIndex: 0 })),
            showTaskWithId: vi.fn(async () => undefined),
        },
        UiServiceClient: {
            subscribeToMcpButtonClicked: stream,
            subscribeToHistoryButtonClicked: stream,
            subscribeToChatButtonClicked: stream,
            subscribeToSettingsButtonClicked: stream,
            subscribeToWorktreesButtonClicked: stream,
            subscribeToPartialMessage: stream,
            subscribeToAccountButtonClicked: stream,
            subscribeToRelinquishControl: stream,
            initializeWebview: vi.fn(async () => undefined),
        },
        McpServiceClient: { subscribeToMcpServers: stream, subscribeToMcpMarketplaceCatalog: stream },
        ModelsServiceClient: {
            subscribeToOpenRouterModels: stream,
            subscribeToLiteLlmModels: stream,
            refreshOpenRouterModelsRpc: vi.fn(async () => ({ models: {} })),
            refreshHicapModels: vi.fn(async () => ({ models: {} })),
            refreshLiteLlmModelsRpc: vi.fn(async () => ({ models: {} })),
            refreshVercelAiGatewayModelsRpc: vi.fn(async () => ({ models: {} })),
            refreshClineModelsRpc: vi.fn(async () => ({ models: {} })),
        },
    }
})

import { HydrationFailed } from "../components/common/HydrationGate"
import { UiLanguageBridge } from "../i18n/UiLanguageBridge"
import { useUiTranslation } from "../i18n/UiLanguageProvider"
import { TaskServiceClient } from "../services/grpc-client"
import { ExtensionStateContextProvider, useExtensionState } from "./ExtensionStateContext"

function Probe() {
    const { uiLanguage, hostDisplayLanguage, preferredLanguage, stateRevision, hydration, retryHydration, openHistoryTask } =
        useExtensionState()
    const { language, t } = useUiTranslation()
    return (
        <>
            <output data-testid="projection">
                {JSON.stringify({ uiLanguage, hostDisplayLanguage, preferredLanguage, stateRevision, language })}
            </output>
            <button type="button">{t("settings.done")}</button>
            <button onClick={() => openHistoryTask({ id: "history-original", task: "Original task" })} type="button">
                open-history
            </button>
            {hydration.status === "failed" && <HydrationFailed onRetry={retryHydration} reason={hydration.reason} />}
        </>
    )
}
async function mount() {
    await act(async () => {
        render(
            <ExtensionStateContextProvider>
                <UiLanguageBridge>
                    <Probe />
                </UiLanguageBridge>
            </ExtensionStateContextProvider>,
        )
    })
}
function publish(state: Record<string, unknown>) {
    act(() => subscription.state!.onResponse({ stateJson: JSON.stringify(state) }))
}
function projection() {
    return JSON.parse(screen.getByTestId("projection").textContent!)
}

describe("committed UI language state hydration", () => {
    beforeEach(() => {
        subscription.state = undefined
    })

    it.each([
        { failure: null, expected: "Unknown state subscription failure" },
        { failure: new Error("transport req_7 failed"), expected: "transport req_7 failed" },
        { failure: "transport raw failure", expected: "transport raw failure" },
    ])("projects stream errors without translating external diagnostics: $expected", async ({ failure, expected }) => {
        await mount()
        act(() => subscription.state!.onError(failure))
        expect(screen.getByTestId("hydration-failed-reason")).toHaveTextContent(expected)
    })

    it("projects an early stream completion as a product-owned reason", async () => {
        await mount()
        act(() => subscription.state!.onComplete())
        expect(screen.getByTestId("hydration-failed-reason")).toHaveTextContent(
            "State subscription closed before any state arrived",
        )
    })

    it("uses the current committed language when a pending history request fails", async () => {
        const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined)
        try {
            let rejectOpen: (error: unknown) => void = () => {
                throw new Error("History request has not started")
            }
            vi.mocked(TaskServiceClient.showTaskWithId).mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        rejectOpen = reject
                    }),
            )
            await mount()
            publish({ stateRevision: 1, uiLanguage: "en", welcomeViewCompleted: true })
            fireEvent.click(screen.getByRole("button", { name: "open-history" }))
            await waitFor(() =>
                expect(TaskServiceClient.showTaskWithId).toHaveBeenCalledWith(
                    expect.objectContaining({ value: "history-original" }),
                ),
            )
            publish({ __dlineStatePatch: true, stateRevision: 2, uiLanguage: "zh-CN" })
            await act(async () => rejectOpen(new Error("rpc failed")))
            expect(alert).toHaveBeenLastCalledWith("无法打开任务“Original task”。")
            expect(TaskServiceClient.showTaskWithId).toHaveBeenCalledTimes(1)
        } finally {
            alert.mockRestore()
        }
    })

    it("starts with auto without persisting an English fallback", async () => {
        await mount()
        expect(projection()).toMatchObject({ uiLanguage: "auto", language: "en", preferredLanguage: "English" })
        expect(document.documentElement.lang).toBe("en")
    })

    it("follows host metadata, applies explicit preference and restores auto through the actual subscription", async () => {
        await mount()
        publish({
            stateRevision: 1,
            uiLanguage: "auto",
            hostDisplayLanguage: "ZH_cn",
            preferredLanguage: "model language",
            welcomeViewCompleted: true,
        })
        expect(projection()).toMatchObject({ uiLanguage: "auto", language: "zh-CN", preferredLanguage: "model language" })
        expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument()
        publish({ __dlineStatePatch: true, stateRevision: 2, uiLanguage: "en" })
        expect(projection()).toMatchObject({
            uiLanguage: "en",
            language: "en",
            hostDisplayLanguage: "ZH_cn",
            preferredLanguage: "model language",
        })
        publish({ __dlineStatePatch: true, stateRevision: 3, uiLanguage: "auto" })
        expect(projection()).toMatchObject({ uiLanguage: "auto", language: "zh-CN", preferredLanguage: "model language" })
        expect(document.documentElement.lang).toBe("zh-CN")
    })

    it("normalizes missing fields in a full old snapshot instead of merging the previous preference or host", async () => {
        await mount()
        publish({ stateRevision: 1, uiLanguage: "zh-CN", hostDisplayLanguage: "zh-CN", welcomeViewCompleted: true })
        publish({ stateRevision: 2, welcomeViewCompleted: true })
        expect(projection()).toMatchObject({ uiLanguage: "auto", language: "en", stateRevision: 2 })
        expect(projection()).not.toHaveProperty("hostDisplayLanguage")
    })

    it("preserves omitted patch fields but normalizes explicitly invalid fields", async () => {
        await mount()
        publish({ stateRevision: 1, uiLanguage: "zh-CN", hostDisplayLanguage: "zh-CN", welcomeViewCompleted: true })
        publish({ __dlineStatePatch: true, stateRevision: 2, version: "new" })
        expect(projection()).toMatchObject({ uiLanguage: "zh-CN", hostDisplayLanguage: "zh-CN", language: "zh-CN" })
        publish({ __dlineStatePatch: true, stateRevision: 3, uiLanguage: "bad", hostDisplayLanguage: 42 })
        expect(projection()).toMatchObject({ uiLanguage: "auto", language: "en" })
        expect(projection()).not.toHaveProperty("hostDisplayLanguage")
    })

    it("ignores pre-hydration patches and stale or duplicate publications", async () => {
        await mount()
        publish({ __dlineStatePatch: true, stateRevision: 5, uiLanguage: "zh-CN" })
        expect(projection()).toMatchObject({ uiLanguage: "auto", language: "en" })
        publish({ stateRevision: 10, uiLanguage: "en", hostDisplayLanguage: "zh-CN", welcomeViewCompleted: true })
        publish({ __dlineStatePatch: true, stateRevision: 9, uiLanguage: "zh-CN" })
        publish({ stateRevision: 10, uiLanguage: "auto", welcomeViewCompleted: true })
        expect(projection()).toMatchObject({ uiLanguage: "en", language: "en", hostDisplayLanguage: "zh-CN", stateRevision: 10 })
    })
})
