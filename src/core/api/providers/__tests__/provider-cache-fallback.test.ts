import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { AIhubmixHandler } from "../aihubmix"
import { VsCodeLmHandler } from "../vscode-lm"

describe("provider cache fallback", () => {
    it("uses the enabled product default before a VS Code model client is available", () => {
        const handler = new VsCodeLmHandler({ profile: ApiProfile.create({ provider: "vscode-lm" }), mode: "act" })
        try {
            const result = handler.getModel()
            expect(result.id).toBe("vscode-lm")
            expect(result.info.id).toBe("vscode-lm")
            expect(result.info.capabilities?.supportsPromptCache).toBe(true)
        } finally {
            handler.dispose()
        }
    })

    it("does not introduce a negative cache default in the unselected AIhubmix fallback", () => {
        const handler = new AIhubmixHandler({ profile: ApiProfile.create({ provider: "aihubmix" }), mode: "act" })
        expect(handler.getModel().info.capabilities?.supportsPromptCache).toBe(true)
    })
})
