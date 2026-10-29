// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { GeminiProvider } from "./GeminiProvider"
import type { ApiProfile } from "./ProviderProfile"

vi.mock("./useProviderModels", () => ({
    useProviderModels: () => ({
        models: {
            "gemini-chat": { id: "gemini-chat", name: "Gemini Chat" },
        },
        defaultModelId: "gemini-chat",
        modelInfoSaneDefaults: { id: "gemini-chat", name: "Gemini Chat" },
        imageModels: {
            "gemini-3.1-flash-image": {
                id: "gemini-3.1-flash-image",
                name: "Nano Banana 2",
            },
            "gemini-3-pro-image-preview": {
                id: "gemini-3-pro-image-preview",
                name: "Nano Banana Pro",
            },
        },
        defaultImageModelId: "gemini-3.1-flash-image",
        loading: false,
    }),
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => <div /> }))
vi.mock("../ReasoningEffortSelector", () => ({ default: () => <div /> }))
vi.mock("../common/ModelSelector", () => ({
    ModelSelector: ({ label, models, onChange, selectedModelId }: any) => (
        <label>
            {label}
            <select aria-label={label} onChange={onChange} value={selectedModelId}>
                {Object.keys(models).map((modelId) => (
                    <option key={modelId} value={modelId}>
                        {modelId}
                    </option>
                ))}
            </select>
        </label>
    ),
}))

describe("GeminiProvider", () => {
    it("leaves image source and model selection to the API Profile card", () => {
        const profile = {
            id: "gemini-images",
            provider: "gemini",
            modelId: "gemini-chat",
            imageModelId: "gemini-3.1-flash-image",
            usedFor: ["plan", "image"],
        } as unknown as ApiProfile

        render(<GeminiProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
        expect(screen.queryByRole("combobox", { name: "Image model" })).not.toBeInTheDocument()
    })
})
