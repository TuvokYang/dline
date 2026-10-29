import { describe, expect, it } from "vitest"
import { encodeNewTaskAsk, parseNewTaskAsk } from "../new-task-ask"

describe("new_task approval presentation", () => {
    it("round-trips the task and the context", () => {
        const ask = { task: "Finish the migration", context: '1. Current Work:\n   {braces} and "quotes"' }

        expect(parseNewTaskAsk(encodeNewTaskAsk(ask))).toEqual(ask)
    })

    it("reads a row written before the tool took a task as that text being the task", () => {
        expect(parseNewTaskAsk("1. Current Work:\n   Legacy context")).toEqual({
            task: "1. Current Work:\n   Legacy context",
            context: "",
        })
    })

    it("keeps a legacy context that merely looks like JSON as the task", () => {
        expect(parseNewTaskAsk('{"unrelated": true}')).toEqual({ task: '{"unrelated": true}', context: "" })
        expect(parseNewTaskAsk("{ not json")).toEqual({ task: "{ not json", context: "" })
        // A single half is never written by the encoder, so it is not the current shape.
        expect(parseNewTaskAsk('{"context":"legacy"}')).toEqual({ task: '{"context":"legacy"}', context: "" })
    })

    it("reads a half that is still streaming as an empty string", () => {
        expect(parseNewTaskAsk(encodeNewTaskAsk({ task: "Finish the", context: "" }))).toEqual({
            task: "Finish the",
            context: "",
        })
        expect(parseNewTaskAsk(undefined)).toEqual({ task: "", context: "" })
    })
})
