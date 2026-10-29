import { describe, expect, it } from "vitest"
import { planExternalStateChange } from "../externalStateChangePlan"

/**
 * The regression this guards: an idle task whose own bookkeeping rewrote the
 * task history made every window reconfigure its runtime components and rebuild
 * the full extension state, which is where an idle CPU baseline came from.
 * These cases state, per source, exactly which of the two effects is required.
 */
describe("planExternalStateChange", () => {
    it("does nothing for a settings commit that changed no keys", () => {
        // The settings repository already refuses to publish such a commit, so
        // reaching this point means a replay. Both effects are pure repetition.
        expect(planExternalStateChange("settings", [])).toEqual({
            reconfigureComponents: false,
            publishState: false,
        })
    })

    it("reconfigures and publishes for a settings commit that changed keys", () => {
        expect(planExternalStateChange("settings", ["mode"])).toEqual({
            reconfigureComponents: true,
            publishState: true,
        })
    })

    it("publishes but does not reconfigure for a task history change", () => {
        // Task history is read during the state build, never by a configured
        // component, so the Webview must still see the new list while the
        // component pass would be wasted work on every history write.
        expect(planExternalStateChange("task_history", [])).toEqual({
            reconfigureComponents: false,
            publishState: true,
        })
    })

    it("publishes but does not reconfigure for an account usage change", () => {
        expect(planExternalStateChange("account_usage", [])).toEqual({
            reconfigureComponents: false,
            publishState: true,
        })
    })

    it("publishes but does not reconfigure for a global state change", () => {
        expect(planExternalStateChange("global_state", [])).toEqual({
            reconfigureComponents: false,
            publishState: true,
        })
    })
})
