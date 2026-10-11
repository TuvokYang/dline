import { describe, expect, it } from "vitest"
import { composerMenuQueryAt } from "../composer-menu"

const at = (text: string) => composerMenuQueryAt(text, text.length)
const slash = (query: string) => ({ menu: "slash", query })
const mention = (query: string) => ({ menu: "mention", query })

describe("composerMenuQueryAt", () => {
    describe("slash menu", () => {
        it("opens at the start of the text or after whitespace", () => {
            expect(at("/")).toEqual(slash(""))
            expect(at("/mcp:ser")).toEqual(slash("mcp:ser"))
            expect(at("please run /new")).toEqual(slash("new"))
        })

        it("opens for a later command too, because composable commands may follow one another", () => {
            expect(at("/skills:lint /wor")).toEqual(slash("wor"))
        })

        it("stays closed where the scanner would read text", () => {
            expect(at("http://example.com/mcp")).toBeUndefined()
            expect(at("src/new")).toBeUndefined()
            expect(at("/foo/bar")).toBeUndefined()
            expect(at("/new task")).toBeUndefined()
            expect(at("\\/new")).toBeUndefined()
            expect(at("`run /new")).toEqual(slash("new"))
            expect(composerMenuQueryAt("`run /new`", 9)).toBeUndefined()
            expect(at("```\n/new")).toBeUndefined()
        })

        it("follows the scanner's escape parity", () => {
            // Two backslashes are a literal backslash, so the command stays active.
            expect(at("\\\\/new")).toEqual(slash("new"))
            // Three leave the sigil escaped.
            expect(at("\\\\\\/new")).toBeUndefined()
        })
    })

    describe("mention menu", () => {
        it("opens for the partial reference after a mention sigil at a boundary", () => {
            expect(at("@")).toEqual(mention(""))
            expect(at("look at @src/ma")).toEqual(mention("src/ma"))
            expect(at("(@src")).toEqual(mention("src"))
        })

        it("stays closed where the scanner would read text", () => {
            expect(at("mail me at a@b")).toBeUndefined()
            expect(at("\\@src")).toBeUndefined()
            // An unmatched backtick is text, so a later mention still completes.
            expect(at("` @src")).toEqual(mention("src"))
            expect(composerMenuQueryAt("` @src`", 6)).toBeUndefined()
            expect(at("```\n@src")).toBeUndefined()
            expect(at("@src now")).toBeUndefined()
        })

        it("stays closed when the text a pick would replace contains code", () => {
            expect(at("@a`b`")).toBeUndefined()
            expect(at("@a`b")).toEqual(mention("a`b"))
        })

        it("offers nothing for references that are complete as typed", () => {
            expect(at("@https://example.com")).toBeUndefined()
            expect(at("@problems")).toBeUndefined()
            expect(at("@terminal")).toBeUndefined()
        })
    })
})
