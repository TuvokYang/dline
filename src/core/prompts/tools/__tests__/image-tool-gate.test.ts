import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { ToolPromptGenerator } from "../../generators/ToolPromptGenerator"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../../system-prompt/context"

function names(context: SystemPromptContext): string[] {
    return (new ToolPromptGenerator().generate(PromptProfile.Standard, context) ?? []).map((tool) => {
        if ("function" in tool && typeof tool.function?.name === "string") return tool.function.name
        if ("name" in tool && typeof tool.name === "string") return tool.name
        return ""
    })
}

const base = {
    promptProfile: PromptProfile.Standard,
    providerInfo: { providerId: "anthropic", model: { id: "claude", info: {} } },
    enableNativeToolCalls: true,
} as unknown as SystemPromptContext

describe("generate_image prompt gate", () => {
    it("exposes the tool only when a valid image profile exists", () => {
        expect(names({ ...base, imageGenerationAvailable: true })).toContain(DlineDefaultTool.GENERATE_IMAGE)
        expect(names({ ...base, imageGenerationAvailable: false })).not.toContain(DlineDefaultTool.GENERATE_IMAGE)
    })
})
