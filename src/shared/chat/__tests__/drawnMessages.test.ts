import { describe, expect, it } from "vitest"
import type { UiMessage } from "../../ExtensionMessage"
import { drawsNothingBetween, filterDrawnMessages } from "../drawnMessages"

const checkpoint = (ts: number): UiMessage => ({ ts, type: "say", say: "checkpoint_created", lastCheckpointHash: ["files"] })
const chatOnlyCheckpoint = (ts: number): UiMessage => ({ ts, type: "say", say: "checkpoint_created" })
const heldCheckpoint = (ts: number): UiMessage => ({ ...checkpoint(ts), partial: true })
const request = (ts: number, failure?: string): UiMessage => ({
    ts,
    type: "say",
    say: "api_req_started",
    text: JSON.stringify(failure ? { streamingFailedMessage: failure } : { cost: 0.01 }),
})
const prose = (ts: number): UiMessage => ({ ts, type: "say", say: "text", text: "Let me look at the files first." })
const readTool = (ts: number): UiMessage => ({
    ts,
    type: "say",
    say: "tool",
    text: JSON.stringify({ tool: "readFile", path: "a.ts" }),
})

describe("drawsNothingBetween", () => {
    it("treats assistant prose as a drawn row between two checkpoints", () => {
        const messages = [checkpoint(1), request(2), prose(3), checkpoint(4)]

        expect(drawsNothingBetween(messages, 1, 4)).toBe(false)
        expect(filterDrawnMessages(messages)).toContainEqual(prose(3))
    })

    it("treats a failed request as drawn until a later attempt supersedes it", () => {
        const failed = [checkpoint(1), request(2, "402 You have run out of credits."), checkpoint(3)]
        expect(drawsNothingBetween(failed, 1, 3)).toBe(false)

        // The retry's own request sorts after the row it reserved, yet it already hides the failure.
        const retried = [...failed, request(4)]
        expect(drawsNothingBetween(retried, 1, 3)).toBe(true)
        expect(
            filterDrawnMessages(retried)
                .filter((message) => message.say === "checkpoint_created")
                .map((message) => message.ts),
        ).toEqual([3])
    })

    it("keeps held rows from erasing the checkpoint evidence between gate bounds", () => {
        expect(drawsNothingBetween([checkpoint(1), chatOnlyCheckpoint(2), heldCheckpoint(3)], 1, 3)).toBe(false)
        expect(drawsNothingBetween([checkpoint(1), checkpoint(2), heldCheckpoint(3)], 1, 3)).toBe(false)
    })

    it("sees a tool row between the bounds and nothing outside them", () => {
        const messages = [readTool(1), checkpoint(2), checkpoint(3), readTool(4), checkpoint(5)]

        expect(drawsNothingBetween(messages, 2, 3)).toBe(true)
        expect(drawsNothingBetween(messages, 3, 5)).toBe(false)
    })
})
