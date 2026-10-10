import { renderHook, waitFor } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContext, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { useProviderModels } from "./useProviderModels"

const mocks = vi.hoisted(() => ({
    providersVersion: 1,
    getAvailableModels: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
    ModelsServiceClient: {
        getAvailableModels: mocks.getAvailableModels,
    },
}))

function catalog(modelId: string, imageModelId = `${modelId}-image`) {
    return {
        providers: [
            {
                provider: "deepseek",
                providerName: "DeepSeek",
                defaultModelId: modelId,
                models: [{ id: modelId, name: modelId }],
                defaultImageModelId: imageModelId,
                imageModels: [{ id: imageModelId, name: imageModelId }],
            },
        ],
    }
}

describe("useProviderModels", () => {
    beforeEach(() => {
        mocks.providersVersion = 1
        mocks.getAvailableModels.mockReset()
        mocks.getAvailableModels.mockResolvedValueOnce(catalog("deepseek-before"))
    })

    it("reloads the shared model catalog when providersVersion changes", async () => {
        const wrapper = ({ children }: PropsWithChildren) => (
            <ExtensionStateContext.Provider value={{ providersVersion: mocks.providersVersion } as ExtensionStateContextType}>
                {children}
            </ExtensionStateContext.Provider>
        )
        const { result, rerender } = renderHook(() => useProviderModels("deepseek"), { wrapper })

        await waitFor(() => expect(result.current.models).toHaveProperty("deepseek-before"))
        expect(mocks.getAvailableModels).toHaveBeenCalledTimes(1)
        rerender()
        expect(mocks.getAvailableModels).toHaveBeenCalledTimes(1)

        mocks.getAvailableModels.mockResolvedValueOnce(catalog("deepseek-after"))
        mocks.providersVersion = 2
        rerender()

        await waitFor(() => expect(result.current.models).toHaveProperty("deepseek-after"))
        expect(result.current.models).not.toHaveProperty("deepseek-before")
        expect(mocks.getAvailableModels).toHaveBeenCalledTimes(2)
    })

    it("returns image models separately from chat models", async () => {
        mocks.providersVersion = 4
        mocks.getAvailableModels.mockReset()
        mocks.getAvailableModels.mockResolvedValueOnce(catalog("deepseek-chat", "deepseek-image"))
        const wrapper = ({ children }: PropsWithChildren) => (
            <ExtensionStateContext.Provider value={{ providersVersion: mocks.providersVersion } as ExtensionStateContextType}>
                {children}
            </ExtensionStateContext.Provider>
        )

        const { result } = renderHook(() => useProviderModels("deepseek"), { wrapper })

        await waitFor(() => expect(result.current.models).toHaveProperty("deepseek-chat"))
        const imageCatalog = result.current as unknown as {
            defaultImageModelId: string
            imageModels: Record<string, { id: string }>
        }
        expect(imageCatalog.defaultImageModelId).toBe("deepseek-image")
        expect(imageCatalog.imageModels).toHaveProperty("deepseek-image")
        expect(result.current.models).not.toHaveProperty("deepseek-image")
    })

    it("exposes refreshed Vercel models before the registry watcher reloads", async () => {
        mocks.providersVersion = 3
        const wrapper = ({ children }: PropsWithChildren) => (
            <ExtensionStateContext.Provider
                value={
                    {
                        providersVersion: mocks.providersVersion,
                        vercelAiGatewayModels: {
                            "anthropic/claude-sonnet": {
                                id: "anthropic/claude-sonnet",
                                name: "Claude Sonnet",
                            },
                        },
                    } as ExtensionStateContextType
                }>
                {children}
            </ExtensionStateContext.Provider>
        )

        const { result } = renderHook(() => useProviderModels("vercel-ai-gateway"), { wrapper })

        await waitFor(() => expect(result.current.models).toHaveProperty("anthropic/claude-sonnet"))
        expect(result.current.defaultModelId).toBe("anthropic/claude-sonnet")
    })
})
