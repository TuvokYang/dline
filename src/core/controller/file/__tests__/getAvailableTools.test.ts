import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { getAvailableTools } from "../getAvailableTools"

describe("getAvailableTools", () => {
    it("includes generate_image in the writable tool catalog", async () => {
        const response = await getAvailableTools({} as never)
        const writeGroup = response.groups.find((group) => group.name === "Write")

        expect(writeGroup?.tools).toContainEqual(
            expect.objectContaining({
                name: ClineDefaultTool.GENERATE_IMAGE,
                isReadOnly: false,
            }),
        )
    })
})
