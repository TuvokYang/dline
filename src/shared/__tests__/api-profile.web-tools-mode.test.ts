import { ApiProfile } from "@shared/proto/dline/profile"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { describe, expect, it } from "vitest"

describe("ApiProfile web tools mode", () => {
    it("preserves an omitted legacy value", () => {
        const profile = ApiProfile.create()

        expect(ApiProfile.fromJSON({}).webToolsMode).toBeUndefined()
        expect(ApiProfile.decode(ApiProfile.encode(profile).finish()).webToolsMode).toBeUndefined()
    })

    it.each([
        WebToolsMode.WEB_TOOLS_MODE_AUTO,
        WebToolsMode.WEB_TOOLS_MODE_FORCE_LOCAL,
        WebToolsMode.WEB_TOOLS_MODE_FORCE_OFF,
        WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE,
    ])("round-trips mode %s through JSON and binary protobuf representations", (webToolsMode) => {
        const profile = ApiProfile.create({ id: "profile-1", webToolsMode })
        const jsonRoundTrip = ApiProfile.fromJSON(ApiProfile.toJSON(profile))
        const binaryRoundTrip = ApiProfile.decode(ApiProfile.encode(profile).finish())

        expect(jsonRoundTrip.webToolsMode).toBe(webToolsMode)
        expect(binaryRoundTrip.webToolsMode).toBe(webToolsMode)
    })
})
