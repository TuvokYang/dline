import { describe, expect, it } from "vitest"
import { findMarkedCommandCompletion } from "../command-completion-marker"

const echo = (token: string) => `runner$ printf 'OUT\\n'; printf '__DLINE_INTERNAL_COMMAND_EXIT__${token}:%s\\n' "$__dline_exit"`

describe("findMarkedCommandCompletion", () => {
    it("finds this command's marker above prompts printed after it", () => {
        const buffer = [
            echo("current"),
            "first line",
            "second line",
            "__DLINE_INTERNAL_COMMAND_EXIT__current:4",
            "runner$",
            "runner$",
        ].join("\n")

        expect(findMarkedCommandCompletion(buffer, "current")).toEqual({ exitCode: 4, output: "first line\nsecond line" })
    })

    it("ignores markers of earlier commands and the echoed wrapper", () => {
        const buffer = [echo("earlier"), "__DLINE_INTERNAL_COMMAND_EXIT__earlier:0", echo("current"), "still running"].join("\n")

        expect(findMarkedCommandCompletion(buffer, "current")).toBeUndefined()
    })

    it("scopes output to this command when earlier commands are in the scrollback", () => {
        const buffer = [
            echo("earlier"),
            "earlier output",
            "__DLINE_INTERNAL_COMMAND_EXIT__earlier:0",
            echo("current"),
            "current output",
            "__DLINE_INTERNAL_COMMAND_EXIT__current:0",
        ].join("\r\n")

        expect(findMarkedCommandCompletion(buffer, "current")).toEqual({ exitCode: 0, output: "current output" })
    })

    it("leaves output undefined instead of returning scrollback when the echo was not captured", () => {
        const buffer = ["unrelated history", "__DLINE_INTERNAL_COMMAND_EXIT__current:2"].join("\n")

        expect(findMarkedCommandCompletion(buffer, "current")).toEqual({ exitCode: 2, output: undefined })
    })
})
