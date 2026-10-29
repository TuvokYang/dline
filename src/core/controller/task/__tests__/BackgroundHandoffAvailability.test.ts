import { describe, expect, it } from "vitest"
import {
    type CommandHandoffSource,
    composeBackgroundHandoffAvailability,
    projectBackgroundHandoffAction,
    type SubagentHandoffSource,
} from "../BackgroundHandoffAvailability"

function commands(ready: string | undefined, requested: string[] = []): CommandHandoffSource {
    return {
        getReadyBackgroundHandoffActivityId: () => ready,
        isBackgroundHandoffRequested: (activityId) => requested.includes(activityId),
    }
}

function subagents(ready: string | undefined): SubagentHandoffSource {
    return { getReadyBackgroundHandoffActivityId: (kind) => (kind === "subagent" ? ready : undefined) }
}

describe("composeBackgroundHandoffAvailability", () => {
    it("offers a running foreground subagent when no command can move", () => {
        const action = projectBackgroundHandoffAction(
            composeBackgroundHandoffAvailability(commands(undefined), subagents("subagent-1")),
        )

        expect(action).toMatchObject({ type: "continue_in_background", activityId: "subagent-1", enabled: true })
    })

    it("prefers a ready foreground command over a subagent", () => {
        const action = projectBackgroundHandoffAction(
            composeBackgroundHandoffAvailability(commands("command-1", ["command-1"]), subagents("subagent-1")),
        )

        expect(action).toMatchObject({ activityId: "command-1", enabled: false })
    })

    it("offers nothing when neither owner has movable foreground work", () => {
        expect(
            projectBackgroundHandoffAction(composeBackgroundHandoffAvailability(commands(undefined), subagents(undefined))),
        ).toBeUndefined()
    })
})
