import { describe, expect, it } from "vitest"
import { rolloutChannelOpen } from "../remote/remoteFeatureFlagsRuntime"

describe("rolloutChannelOpen", () => {
    it("opens only for a device that reports both usage and errors", () => {
        expect(rolloutChannelOpen(true, "enabled")).toBe(true)
    })

    it("stays closed when error reporting is refused or not yet answered", () => {
        expect(rolloutChannelOpen(true, "disabled")).toBe(false)
        expect(rolloutChannelOpen(true, "unset")).toBe(false)
    })

    it("stays closed when usage reporting is not allowed, whatever error reporting says", () => {
        expect(rolloutChannelOpen(false, "enabled")).toBe(false)
        expect(rolloutChannelOpen(false, "disabled")).toBe(false)
    })
})
