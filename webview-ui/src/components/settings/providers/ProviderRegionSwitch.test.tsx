// @vitest-environment jsdom
/**
 * Region switching for Z AI and Qwen.
 *
 * Both providers keep one catalog per endpoint, so a Profile that switches region
 * reads a different model set. The rule this file pins is that the switch always
 * lands on a model the new catalog serves: the current selection is kept when the
 * new catalog has it, and the catalog's default otherwise. An empty id would leave
 * the Profile unable to send any request at all.
 */
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import { QwenProviderConfig } from "@shared/proto/dline/provider/qwen"
import { ZAiProviderConfig } from "@shared/proto/dline/provider/zai"
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { QwenProvider } from "./QwenProvider"
import { ZAiProvider } from "./ZAiProvider"

/**
 * One catalog per key, with deliberately different members.
 *
 * `shared` exists in both, so a switch that keeps a valid selection is
 * distinguishable from one that always resets.
 */
const catalogs: Record<string, { models: Record<string, ModelInfo>; defaultModelId: string }> = {
    zai: {
        models: { "glm-intl-default": { id: "glm-intl-default" }, shared: { id: "shared" } },
        defaultModelId: "glm-intl-default",
    },
    "zai-cn": {
        models: { "glm-cn-default": { id: "glm-cn-default" }, shared: { id: "shared" } },
        defaultModelId: "glm-cn-default",
    },
    qwen: {
        models: { "qwen-intl-default": { id: "qwen-intl-default" }, shared: { id: "shared" } },
        defaultModelId: "qwen-intl-default",
    },
    "qwen-cn": {
        models: { "qwen-cn-default": { id: "qwen-cn-default" }, shared: { id: "shared" } },
        defaultModelId: "qwen-cn-default",
    },
}

vi.mock("./useProviderModels", () => ({
    useProviderModels: (providerId: string) => {
        const catalog = catalogs[providerId] ?? { models: {}, defaultModelId: "" }
        return {
            ...catalog,
            modelInfoSaneDefaults: catalog.models[catalog.defaultModelId] ?? {},
            imageModels: {},
            defaultImageModelId: "",
            loading: false,
        }
    },
}))

vi.mock("./useProviderModelOptions", () => ({
    useProviderModelOptions: ({ providerId }: { providerId: string }) => {
        const catalog = catalogs[providerId] ?? { models: {}, defaultModelId: "" }
        return {
            ...catalog,
            modelInfoSaneDefaults: catalog.models[catalog.defaultModelId] ?? {},
            imageModels: {},
            defaultImageModelId: "",
            loading: false,
            options: catalog.models,
            optionOrigins: {},
            refreshRemoteModels: vi.fn(),
        }
    },
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => <div /> }))
vi.mock("../common/ModelAutocomplete", () => ({
    ModelAutocomplete: ({ models, selectedModelId }: { models: Record<string, ModelInfo>; selectedModelId: string }) => (
        <div data-testid="model-options">{Object.keys(models).join(",")}</div>
    ),
}))

/**
 * `VSCodeDropdown` is a custom element without a value setter, so `fireEvent.change`
 * cannot construct it. `vsCodeDropdownOnChange` reads `event.target.value`, and an
 * `Event`'s `target` is read-only until dispatch, so the value goes on the element
 * that is about to become that target.
 */
function selectOption(label: string, value: string) {
    const dropdown = screen.getByLabelText(label) as HTMLElement & { value?: string }
    dropdown.value = value
    dropdown.dispatchEvent(new Event("change", { bubbles: true }))
}

afterEach(() => {
    vi.clearAllMocks()
})

describe("Z AI region switch", () => {
    it("falls back to the mainland default when the current model is not served there", () => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider: "zai",
            modelId: "glm-intl-default",
            zai: ZAiProviderConfig.create({ zaiApiLine: "international" }),
        })
        render(<ZAiProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

        selectOption("Z AI Entrypoint", "china")

        expect(onUpdate).toHaveBeenCalledTimes(1)
        const update = onUpdate.mock.calls[0][0]
        expect(update.modelId).toBe("glm-cn-default")
        expect(update.modelId).not.toBe("")
        expect(update.modelInfo).toEqual({ id: "glm-cn-default" })
    })

    it("keeps a selection both endpoints serve", () => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider: "zai",
            modelId: "shared",
            zai: ZAiProviderConfig.create({ zaiApiLine: "international" }),
        })
        render(<ZAiProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

        selectOption("Z AI Entrypoint", "china")

        expect(onUpdate.mock.calls[0][0].modelId).toBe("shared")
    })

    it("does nothing when the selected entrypoint is already the current one", () => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider: "zai",
            modelId: "glm-intl-default",
            zai: ZAiProviderConfig.create({ zaiApiLine: "international" }),
        })
        render(<ZAiProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

        selectOption("Z AI Entrypoint", "international")

        expect(onUpdate).not.toHaveBeenCalled()
    })
})

describe("Qwen API-line switch", () => {
    it("falls back to the mainland default when the current model is not served there", () => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider: "qwen",
            modelId: "qwen-intl-default",
            qwen: QwenProviderConfig.create({ qwenApiLine: "international" }),
        })
        render(<QwenProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

        selectOption("Alibaba API Line", "china")

        expect(onUpdate).toHaveBeenCalledTimes(1)
        const update = onUpdate.mock.calls[0][0]
        expect(update.modelId).toBe("qwen-cn-default")
        expect(update.modelId).not.toBe("")
        expect(update.modelInfo).toEqual({ id: "qwen-cn-default" })
    })

    it("keeps a selection both API lines serve", () => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider: "qwen",
            modelId: "shared",
            qwen: QwenProviderConfig.create({ qwenApiLine: "international" }),
        })
        render(<QwenProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

        selectOption("Alibaba API Line", "china")

        expect(onUpdate.mock.calls[0][0].modelId).toBe("shared")
    })
})
