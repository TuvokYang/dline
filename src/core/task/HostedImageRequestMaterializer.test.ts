import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { HostedImageRequestMaterializer } from "./HostedImageRequestMaterializer"

describe("HostedImageRequestMaterializer", () => {
    it("freezes pure default options across retries without reading composer state", async () => {
        const materializer = new HostedImageRequestMaterializer()
        const requestScope = {}

        const firstAttempt = materializer.materialize(requestScope, [ServerTool.IMAGE_GENERATION])
        const retryAttempt = materializer.materialize(requestScope, [ServerTool.IMAGE_GENERATION])

        expect(retryAttempt).toBe(firstAttempt)
        expect(await firstAttempt).toEqual({ references: [], partialImages: 3, size: { width: 2048, height: 1152 } })
    })

    it("accepts request-scoped output overrides and disables legacy projection without the server tool", async () => {
        const materializer = new HostedImageRequestMaterializer()

        expect(await materializer.materialize({}, [])).toBeUndefined()
        expect(
            await materializer.materialize({}, [ServerTool.IMAGE_GENERATION], {
                partialImages: 1,
                size: { width: 1024, height: 1024 },
            }),
        ).toEqual({ references: [], partialImages: 1, size: { width: 1024, height: 1024 } })
    })
})
