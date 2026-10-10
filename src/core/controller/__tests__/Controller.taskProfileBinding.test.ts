import { Controller } from "@core/controller"
import { describe, expect, it, vi } from "vitest"

type TaskSettingsCache = Record<string, unknown>

/** A Controller reduced to the state access the binding step actually performs. */
function createController(cache: TaskSettingsCache, configuration: Record<string, string | undefined>) {
    const setTaskSettings = vi.fn((_taskId: string, key: string, value: unknown) => {
        cache[key] = value
    })
    const controller = {
        stateManager: {
            getTaskCacheRef: () => cache,
            getApiConfigurationForTask: () => configuration,
            setTaskSettings,
        },
    }
    const bind = Reflect.get(Controller.prototype, "bindTaskProfileOnCreate") as (this: typeof controller, taskId: string) => void
    return { bind: () => bind.call(controller, "task-1"), cache, setTaskSettings }
}

/**
 * A task must own the Profile it starts on, the same way it already owns its
 * mode and capability toggles. Without its own binding the task only reads the
 * globally selected Profile, so a later global switch silently rewrites what a
 * finished task ran on.
 */
describe("Controller task Profile binding", () => {
    it("freezes the resolved Profile identity into a new task's settings", () => {
        const { bind, cache, setTaskSettings } = createController(
            { mode: "act" },
            {
                planModeProfileId: "plan-id",
                planModeProfile: "plan-profile",
                actModeProfileId: "act-id",
                actModeProfile: "act-profile",
            },
        )

        bind()

        expect(setTaskSettings).toHaveBeenCalledTimes(4)
        expect(cache).toMatchObject({
            planModeProfileId: "plan-id",
            planModeProfile: "plan-profile",
            actModeProfileId: "act-id",
            actModeProfile: "act-profile",
        })
    })

    it("leaves a resumed task's own binding alone", () => {
        // The global selection has moved on since this task ran. Seeding it now
        // would resume the task on a Profile it never used, which is exactly the
        // drift the binding exists to prevent.
        const { bind, cache, setTaskSettings } = createController(
            { mode: "act", actModeProfileId: "recorded-id", actModeProfile: "recorded-profile" },
            { actModeProfileId: "current-global-id", actModeProfile: "current-global-profile" },
        )

        bind()

        expect(setTaskSettings).not.toHaveBeenCalled()
        expect(cache).toMatchObject({ actModeProfileId: "recorded-id", actModeProfile: "recorded-profile" })
    })

    it("writes only the bindings the resolved configuration actually carries", () => {
        // A profile-less configuration has nothing to freeze; writing `undefined`
        // would make the task look bound to a Profile that does not exist.
        const { bind, cache, setTaskSettings } = createController({}, { actModeProfileId: "act-id" })

        bind()

        expect(setTaskSettings).toHaveBeenCalledExactlyOnceWith("task-1", "actModeProfileId", "act-id")
        expect(cache).toEqual({ actModeProfileId: "act-id" })
    })
})
