import { describe, expect, it } from "vitest"
import { ClineDefaultTool } from "../../../../shared/tools"
import { PromptProfile } from "../../profiles/types"
import type { ProfileToolSpec } from "../profile-tool-set"
import { ProfileToolError, ProfileToolSet } from "../profile-tool-set"
import { createToolSet, LITE_TOOL_IDS, STANDARD_TOOL_IDS } from "../tool-profile"

/** Creates a minimal exact-profile tool spec for resolver tests. */
function makeSpec(profile: PromptProfile, id: ClineDefaultTool): ProfileToolSpec {
    return {
        profile,
        transport: "both",
        id,
        name: id,
        description: `${profile}:${id}`,
    }
}

describe("ProfileToolSet", () => {
    it("resolves exact profile tools and preserves requested order", () => {
        const tools = new ProfileToolSet()
        const read = makeSpec(PromptProfile.Standard, ClineDefaultTool.FILE_READ)
        const search = makeSpec(PromptProfile.Standard, ClineDefaultTool.SEARCH)
        tools.register(read)
        tools.register(search)

        expect(tools.get(PromptProfile.Standard, ClineDefaultTool.FILE_READ)).toBe(read)
        expect(tools.list(PromptProfile.Standard, [ClineDefaultTool.SEARCH, ClineDefaultTool.FILE_READ])).toEqual([search, read])
    })

    it("does not borrow a tool from another profile", () => {
        const tools = new ProfileToolSet()
        tools.register(makeSpec(PromptProfile.Standard, ClineDefaultTool.BROWSER))

        expect(() => tools.get(PromptProfile.Lite, ClineDefaultTool.BROWSER)).toThrowError(
            expect.objectContaining({
                name: "ProfileToolError",
                reason: "missing-tool",
                profile: PromptProfile.Lite,
                toolId: ClineDefaultTool.BROWSER,
            }),
        )
    })

    it("rejects duplicate tools within one profile", () => {
        const tools = new ProfileToolSet()
        tools.register(makeSpec(PromptProfile.Standard, ClineDefaultTool.FILE_READ))

        expect(() => tools.register(makeSpec(PromptProfile.Standard, ClineDefaultTool.FILE_READ))).toThrowError(ProfileToolError)
        expect(() => tools.register(makeSpec(PromptProfile.Standard, ClineDefaultTool.FILE_READ))).toThrowError(
            expect.objectContaining({ reason: "duplicate-tool", profile: PromptProfile.Standard }),
        )
    })

    it("registers every declared production tool under its exact profile", () => {
        const tools = createToolSet()

        expect(tools.list(PromptProfile.Standard, STANDARD_TOOL_IDS).map((tool) => tool.id)).toEqual(STANDARD_TOOL_IDS)
        expect(tools.list(PromptProfile.Lite, LITE_TOOL_IDS).map((tool) => tool.id)).toEqual(LITE_TOOL_IDS)
        expect(() => tools.get(PromptProfile.Lite, ClineDefaultTool.BROWSER)).toThrowError(
            expect.objectContaining({ reason: "missing-tool", profile: PromptProfile.Lite }),
        )
    })
})
