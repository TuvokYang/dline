import { readFileSync } from "node:fs"
import path from "node:path"
import { transformSync } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"
import { interpretBuildId, readBuildIdentity, UNKNOWN_BUILD_ID } from "../build-identity"

describe("interpretBuildId", () => {
    it("reports the id stamped by the build", () => {
        expect(interpretBuildId("a1b2c3d")).toEqual({
            buildId: "a1b2c3d",
            symbolicatable: true,
        })
    })

    it("reports unknown when the build did not stamp an id", () => {
        // Guessing an id would let a maintainer decode a stack trace with the
        // wrong map and get confidently wrong file names.
        expect(interpretBuildId(undefined)).toEqual({
            buildId: UNKNOWN_BUILD_ID,
            symbolicatable: false,
        })
    })

    it("treats a blank id as unknown", () => {
        expect(interpretBuildId("   ").symbolicatable).toBe(false)
    })

    it("does not claim a dev build is symbolicatable", () => {
        // A dev build is readable because it is not minified, but no archived
        // map corresponds to it.
        expect(interpretBuildId("dev")).toEqual({
            buildId: "dev",
            symbolicatable: false,
        })
    })
})

describe("readBuildIdentity", () => {
    const original = process.env.DLINE_BUILD_ID

    afterEach(() => {
        if (original === undefined) delete process.env.DLINE_BUILD_ID
        else process.env.DLINE_BUILD_ID = original
    })

    it("reads the value at the substitution site", () => {
        process.env.DLINE_BUILD_ID = "stamped-id"
        expect(readBuildIdentity()).toEqual({ buildId: "stamped-id", symbolicatable: true })
    })

    it("compiles to the stamped id rather than a runtime environment lookup", () => {
        // esbuild `define` replaces the literal expression
        // `process.env.DLINE_BUILD_ID`. Capturing `process.env` into a
        // variable first would still typecheck and still pass the unit tests
        // above, but would compile to a real lookup and make every released
        // build report `unknown`. Running the actual substitution is the only
        // check that fails when that happens.
        const source = readFileSync(path.join(__dirname, "..", "build-identity.ts"), "utf8")

        const { code } = transformSync(source, {
            loader: "ts",
            define: { "process.env.DLINE_BUILD_ID": JSON.stringify("release-abc123") },
        })

        expect(code).toContain("release-abc123")
        expect(code).not.toContain("process.env.DLINE_BUILD_ID")
    })
})
