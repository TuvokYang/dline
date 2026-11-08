import { describe, expect, it } from "vitest"
import { settingsAffectPromptFreshness } from "@/core/prompts/system-prompt-cache/PromptFreshnessProjection"
import { planExternalStateChange } from "../externalStateChangePlan"

describe("UI language committed change plan", () => {
    it("publishes local or external language-only commits without configuring runtime components", () => {
        expect(planExternalStateChange("settings", ["uiLanguage"])).toEqual({
            reconfigureComponents: false,
            publishState: true,
        })
        expect(settingsAffectPromptFreshness(["uiLanguage"])).toBe(false)
    })

    it.each([
        "preferredLanguage",
        "defaultTerminalProfile",
        "mode",
        "awayModeEnabled",
    ])("preserves runtime reconfiguration for a mixed commit with %s", (key) => {
        expect(planExternalStateChange("settings", ["uiLanguage", key])).toEqual({
            reconfigureComponents: true,
            publishState: true,
        })
    })

    it("does not turn an empty settings replay into a language publication", () => {
        expect(planExternalStateChange("settings", [])).toEqual({
            reconfigureComponents: false,
            publishState: false,
        })
    })
})
