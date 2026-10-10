import { ApiProfile } from "@shared/proto/dline/profile"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ImageGenerationProfileSettingsEditor } from "./ImageGenerationProfileSettingsEditor"

describe("ImageGenerationProfileSettingsEditor", () => {
    it("shows the three-minute request timeout when the Profile has no override", () => {
        render(
            <ImageGenerationProfileSettingsEditor
                onUpdate={vi.fn()}
                profile={ApiProfile.create({ id: "profile-1", name: "Profile", provider: "openai", enabled: true })}
            />,
        )

        expect(screen.getByText("Request timeout (ms)").closest("vscode-text-field")).toHaveProperty("value", "180000")
    })
})
