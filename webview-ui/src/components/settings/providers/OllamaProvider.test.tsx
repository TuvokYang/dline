// @vitest-environment jsdom
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { OllamaProviderConfig } from "@shared/proto/dline/provider/ollama"
import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { OllamaProvider } from "./OllamaProvider"

vi.mock("react-use", () => ({ useInterval: vi.fn() }))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ apiConfiguration: {}, customPrompt: "" }),
}))

vi.mock("@/services/grpc-client", () => ({
    ModelsServiceClient: { getOllamaModels: vi.fn(() => new Promise(() => {})) },
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => null }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => null }))
vi.mock("../common/DebouncedTextField", () => ({
    DebouncedTextField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../OllamaModelPicker", () => ({ default: () => <div>Model picker</div> }))
vi.mock("../UseCustomPromptCheckbox", () => ({ default: () => null }))
vi.mock("../utils/useApiConfigurationHandlers", () => ({
    useApiConfigurationHandlers: () => ({ handleFieldChange: vi.fn() }),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeLink: ({ children }: { children: ReactNode }) => <a href="#ollama">{children}</a>,
}))

describe("OllamaProvider", () => {
    it("shows Lite prompt guidance for the default 32K context window", () => {
        const profile = {
            id: "ollama-default",
            provider: "ollama",
            modelId: "llama3.1",
            ollama: OllamaProviderConfig.create(),
        } as ApiProfile

        render(<OllamaProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

        expect(screen.getByText("Lite prompt profile")).toBeInTheDocument()
        expect(screen.getByRole("status")).toHaveTextContent("below 64K tokens")
        expect(screen.queryByText("Dline uses complex prompts", { exact: false })).not.toBeInTheDocument()
    })

    it("shows metadata guidance when a larger-context model has unknown native tool support", () => {
        const profile = {
            id: "ollama-large",
            provider: "ollama",
            modelId: "large-model",
            ollama: OllamaProviderConfig.create({ ollamaApiOptionsCtxNum: "128000" }),
        } as ApiProfile

        render(<OllamaProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

        expect(screen.getByText("Model metadata incomplete")).toBeInTheDocument()
    })

    it("does not show guidance when larger-context metadata is complete", () => {
        const profile = {
            id: "ollama-known",
            provider: "ollama",
            modelId: "known-model",
            ollama: OllamaProviderConfig.create({
                ollamaApiOptionsCtxNum: "128000",
                capabilities: { supportsTools: false } as ModelCapabilities,
            }),
        } as ApiProfile

        render(<OllamaProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

        expect(screen.queryByRole("status")).not.toBeInTheDocument()
        expect(screen.queryByText("Dline uses complex prompts", { exact: false })).not.toBeInTheDocument()
    })
})
