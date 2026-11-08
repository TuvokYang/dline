import { ApiProfile } from "@shared/proto/dline/profile"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import ProviderProfileCard from "./ProviderProfileCard"
import { applyProfileUpdate } from "./useApiProfiles"

vi.mock("@/context/ExtensionStateContext", async () => {
    const { createContext } = await import("react")
    return { ExtensionStateContext: createContext(undefined) }
})
vi.mock("@/services/grpc-client", () => ({ FileServiceClient: {}, StateServiceClient: {} }))
vi.mock("./ProviderProfileEditor", () => ({ default: () => null }))
vi.mock("./useProviderModels", () => ({
    useProviderModels: () => ({ models: {}, imageModels: {}, defaultModelId: "", defaultImageModelId: "", loading: false }),
    getCachedProviderDefaultModelId: () => "model-id",
    getCachedProviderDefaultImageModelId: () => "",
}))

const initialProfile = ApiProfile.create({
    id: "profile-identity",
    name: "New Model",
    usedFor: ["act", "plan", "subagents"],
    webToolsMode: WebToolsMode.WEB_TOOLS_MODE_AUTO,
    enabled: true,
})

function Fixture({ initial = initialProfile }: { initial?: ApiProfile }) {
    const [profile, setProfile] = useState(initial)
    const [expanded, setExpanded] = useState(false)
    return (
        <>
            <ProviderProfileCard
                currentMode="act"
                editMode={false}
                imageGenerationEnabled={false}
                imageProfiles={[]}
                isExpanded={expanded}
                onDelete={() => {}}
                onToggleExpand={() => setExpanded((value) => !value)}
                onUpdate={(patch) => setProfile((current) => applyProfileUpdate([current], current.id, patch).profiles[0])}
                profile={profile}
                providerOptions={[{ value: "openai", label: "OpenAI" }]}
            />
            <output data-testid="stored-profile">{JSON.stringify(profile)}</output>
        </>
    )
}

function tree(language: UiLanguage, initial?: ApiProfile) {
    return (
        <UiLanguageProvider language={language}>
            <Fixture initial={initial} />
        </UiLanguageProvider>
    )
}

function stored(): ApiProfile {
    return ApiProfile.fromJSON(JSON.parse(screen.getByTestId("stored-profile").textContent ?? "{}"))
}

describe("Profile language changes preserve identity", () => {
    it("translates only the New Model display fallback and preserves an open name draft in both directions", () => {
        const view = render(tree("en"))
        expect(screen.getByRole("button", { name: "Expand New Model" })).toBeVisible()
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: "展开 新模型" })).toBeVisible()
        expect(stored().name).toBe("New Model")

        fireEvent.click(screen.getByRole("button", { name: "展开 新模型" }))
        const name = screen.getByRole("textbox", { name: "配置名称" })
        expect(name).toHaveValue("New Model")
        fireEvent.change(name, { target: { value: "My custom 名称" } })
        view.rerender(tree("en"))
        expect(screen.getByRole("textbox", { name: "Profile name" })).toBe(name)
        expect(name).toHaveValue("My custom 名称")
        expect(screen.getByRole("button", { name: "Collapse New Model" })).toBeVisible()
        expect(stored()).toMatchObject({ id: "profile-identity", name: "New Model", provider: "", modelId: "" })

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("textbox", { name: "配置名称" })).toBe(name)
        fireEvent.blur(name)
        expect(stored().name).toBe("My custom 名称")
        expect(screen.getByRole("button", { name: "折叠 My custom 名称" })).toBeVisible()
        fireEvent.click(screen.getByRole("checkbox", { name: "子代理" }))
        expect(stored().usedFor).toEqual(["act", "plan"])
        view.rerender(tree("en"))
        expect(screen.getByRole("textbox", { name: "Profile name" })).toHaveValue("My custom 名称")
        expect(screen.getByRole("checkbox", { name: "Subagents" })).not.toBeChecked()
        expect(screen.getByTitle("Used for act")).toHaveTextContent("ACT")
        expect(stored().id).toBe("profile-identity")
    })

    it("keeps provider/model auto-naming and protocol values independent of the display fallback", () => {
        const view = render(tree("zh-CN"))
        fireEvent.click(screen.getByRole("button", { name: "展开 新模型" }))
        fireEvent.change(screen.getByLabelText("提供商"), { target: { value: "openai" } })
        expect(stored()).toMatchObject({
            id: "profile-identity",
            name: "openai:model-id",
            provider: "openai",
            modelId: "model-id",
            usedFor: ["act", "plan", "subagents"],
            webToolsMode: WebToolsMode.WEB_TOOLS_MODE_AUTO,
        })
        const committed = stored()
        view.rerender(tree("en"))
        expect(screen.getByRole("textbox", { name: "Profile name" })).toHaveValue("openai:model-id")
        expect(screen.getByTitle("Used for subagents")).toHaveTextContent("SUB")
        expect(stored()).toEqual(committed)
        // The existing sentinel and provider-prefixed name criteria remain storage-only.
        expect(applyProfileUpdate([committed], committed.id, { modelId: "next-id" }).profiles[0].name).toBe("openai:next-id")
    })

    it("does not translate a user-owned name on a configured provider", () => {
        const profile = ApiProfile.create({ ...initialProfile, name: "New Model", provider: "openai", modelId: "custom-id" })
        const view = render(tree("en", profile))
        view.rerender(tree("zh-CN", profile))
        expect(screen.getByRole("button", { name: "展开 New Model" })).toBeVisible()
        expect(stored()).toEqual(profile)
        view.rerender(tree("en", profile))
        expect(screen.getByRole("button", { name: "Expand New Model" })).toBeVisible()
        expect(stored()).toEqual(profile)
    })
})
