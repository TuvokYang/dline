// @vitest-environment jsdom
import type { ApiProfile } from "@shared/proto/dline/profile"
import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { LiteLlmProvider } from "./LiteLlmProvider"

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        remoteConfigSettings: {},
        liteLlmModels: {},
        refreshLiteLlmModels: vi.fn(),
    }),
}))

vi.mock("../common/DebouncedTextField", () => ({
    DebouncedTextField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("../common/ModelAutocomplete", () => ({
    ModelAutocomplete: () => <div>Model selector</div>,
}))

vi.mock("../common/ModelInfoView", () => ({
    ModelInfoView: ({ modelInfo }: { modelInfo?: unknown }) => {
        if (!modelInfo) throw new Error("ModelInfoView requires modelInfo")
        return <div>Model info</div>
    },
}))

vi.mock("../common/RemotelyConfiguredInputWrapper", () => ({
    LockIcon: () => null,
    RemotelyConfiguredInputWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
    VSCodeLink: ({ children }: { children: ReactNode }) => <a href="#litellm">{children}</a>,
}))

describe("LiteLlmProvider", () => {
    it("renders an empty custom model profile without requiring model metadata", () => {
        const profile = {
            id: "profile-1",
            provider: "litellm",
            modelId: "",
        } as ApiProfile

        expect(() => render(<LiteLlmProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)).not.toThrow()
        expect(screen.getByText("Model selector")).toBeInTheDocument()
        expect(screen.queryByText("Model info")).not.toBeInTheDocument()
    })
})
