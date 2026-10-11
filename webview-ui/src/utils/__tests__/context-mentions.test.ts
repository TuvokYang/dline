import { describe, expect, it } from "vitest"
import { removeMention } from "../context-mentions"

describe("context-mentions", () => {
    describe("removeMention", () => {
        it("removes a whole mention ending at the caret", () => {
            expect(removeMention("hi @/src/a.ts", 13)).toEqual({ newText: "hi ", newPosition: 3 })
        })

        it("removes the space after the mention with it", () => {
            expect(removeMention("@problems more", 9)).toEqual({ newText: "more", newPosition: 0 })
        })

        it("leaves text unchanged when the caret is not at the end of a mention", () => {
            expect(removeMention("plain", 5)).toEqual({ newText: "plain", newPosition: 5 })
        })
    })
})
