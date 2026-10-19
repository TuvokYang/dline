import { describe, expect, it } from "vitest"
import {
    formatMultiRootWorkingDirectoryHeader,
    formatWorkingDirectoryHeader,
    readWorkingDirectoryHeader,
} from "../working-directory-header"

describe("working directory header", () => {
    it("reads back the directory a single-root request was written with", () => {
        const request = `<task>fix it</task>\n<environment_details>${formatWorkingDirectoryHeader("e:/work (copy)/app")}src/\n</environment_details>`

        expect(readWorkingDirectoryHeader(request)).toBe("e:/work (copy)/app")
    })

    it("does not mistake a multi-root primary name for a path", () => {
        const request = `<environment_details>${formatMultiRootWorkingDirectoryHeader("app")}</environment_details>`

        expect(readWorkingDirectoryHeader(request)).toBeUndefined()
    })

    it("finds nothing in a request without environment details", () => {
        expect(readWorkingDirectoryHeader("<task>fix it</task>")).toBeUndefined()
    })
})
