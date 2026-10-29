import { describe, expect, it } from "vitest"
import { parsePermissionRules, withAdditionalRules } from "./permission-rules"

/** Split rule text back into lines for readable assertions. */
function lines(text: string): string[] {
    return text ? text.split("\n") : []
}

describe("parsePermissionRules", () => {
    it("removes every permission for a line without attributes", () => {
        const rules = parsePermissionRules("secrets/\n.env\n")

        for (const permission of ["read", "write", "execute", "scan"] as const) {
            expect(lines(rules[permission])).toEqual(["secrets/", ".env"])
        }
    })

    it("removes only the named permission", () => {
        const rules = parsePermissionRules("tmp/  -s\n")

        expect(lines(rules.scan)).toEqual(["tmp/"])
        expect(rules.read).toBe("")
        expect(rules.write).toBe("")
        expect(rules.execute).toBe("")
    })

    it("accepts several attribute tokens on one line", () => {
        const rules = parsePermissionRules("build/ -s -w\n")

        expect(lines(rules.scan)).toEqual(["build/"])
        expect(lines(rules.write)).toEqual(["build/"])
        expect(rules.read).toBe("")
    })

    it("accepts a compact attribute token", () => {
        const compact = parsePermissionRules("coverage/ -sw\n")
        const spaced = parsePermissionRules("coverage/ -s -w\n")

        expect(compact).toEqual(spaced)
    })

    it("keeps the pattern untouched so gitignore syntax still applies", () => {
        const rules = parsePermissionRules("!audit.log -w\nsrc/**/*.gen.ts -s\n")

        expect(lines(rules.write)).toEqual(["!audit.log"])
        expect(lines(rules.scan)).toEqual(["src/**/*.gen.ts"])
    })

    it("treats a trailing word that is not an attribute as part of the pattern", () => {
        // A filename may legitimately contain spaces; only tokens shaped exactly
        // like an attribute may be stripped.
        const rules = parsePermissionRules("my notes.txt\n")

        expect(lines(rules.read)).toEqual(["my notes.txt"])
        expect(lines(rules.scan)).toEqual(["my notes.txt"])
    })

    it("stops stripping at the first token that is not an attribute", () => {
        const rules = parsePermissionRules("release notes -s\n")

        expect(lines(rules.scan)).toEqual(["release notes"])
        expect(rules.read).toBe("")
    })

    it("keeps an escaped attribute-like filename in the pattern", () => {
        const rules = parsePermissionRules("build\\ -w\n")

        // The escape belongs to gitignore, so the matcher must still see it.
        expect(lines(rules.read)).toEqual(["build\\ -w"])
        expect(lines(rules.write)).toEqual(["build\\ -w"])
    })

    it("ignores blank lines and comments", () => {
        const rules = parsePermissionRules("\n# a comment -w\n\nsecrets/\n")

        expect(lines(rules.read)).toEqual(["secrets/"])
    })

    it("rejects an unknown attribute letter and keeps the token in the pattern", () => {
        const rules = parsePermissionRules("weird/ -q\n")

        expect(lines(rules.read)).toEqual(["weird/ -q"])
        expect(lines(rules.scan)).toEqual(["weird/ -q"])
    })

    it("returns empty rule text when no file contributed", () => {
        expect(parsePermissionRules(undefined)).toEqual({ read: "", write: "", execute: "", scan: "" })
    })

    it("keeps a line that is only attributes out of the result", () => {
        const rules = parsePermissionRules("-s\n")

        // Without a pattern there is nothing to match, but "-s" alone is also a
        // valid gitignore pattern, so it stays as one.
        expect(lines(rules.read)).toEqual(["-s"])
    })
})

describe("withAdditionalRules", () => {
    it("layers the additional rules first so workspace negations still win", () => {
        const base = parsePermissionRules("!audit.log -s\n")
        const extended = withAdditionalRules(base, "scan", "*.log")

        // A later gitignore rule wins, so the workspace line must stay last.
        expect(lines(extended.scan)).toEqual(["*.log", "!audit.log"])
    })

    it("extends one permission and leaves the others alone", () => {
        const base = parsePermissionRules("secrets/\n")
        const extended = withAdditionalRules(base, "scan", "node_modules/")

        expect(lines(extended.scan)).toEqual(["node_modules/", "secrets/"])
        expect(lines(extended.read)).toEqual(["secrets/"])
    })

    it("uses the additional rules when the permission was empty", () => {
        const base = parsePermissionRules("tmp/ -s\n")
        const extended = withAdditionalRules(base, "write", ".git/")

        expect(lines(extended.write)).toEqual([".git/"])
    })

    it("returns the original set when there is nothing to add", () => {
        const base = parsePermissionRules("secrets/\n")

        expect(withAdditionalRules(base, "scan", undefined)).toBe(base)
        expect(withAdditionalRules(base, "scan", "")).toBe(base)
    })
})
