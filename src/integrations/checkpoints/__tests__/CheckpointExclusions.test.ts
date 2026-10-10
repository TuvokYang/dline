import fs from "fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeExcludesFile } from "../CheckpointExclusions"

vi.mock("fs/promises", () => ({
    default: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    },
}))

describe("writeExcludesFile", () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    it("persists repository boundary patterns in the shadow repository excludes", async () => {
        await writeExcludesFile("C:/shadow/.git", ["*.large"], "tmp/", ["/packages/submodule/", "/packages/nested/"])

        expect(fs.writeFile).toHaveBeenCalledOnce()
        const [, content] = vi.mocked(fs.writeFile).mock.calls[0] ?? []
        expect(content).toEqual(expect.stringContaining("/packages/submodule/"))
        expect(content).toEqual(expect.stringContaining("/packages/nested/"))
        expect(content).toEqual(expect.stringContaining("*.large"))
        expect(content).toEqual(expect.stringContaining("tmp/"))
    })

    it("reports an unchanged ruleset so callers can keep the existing shadow index", async () => {
        const first = await writeExcludesFile("C:/shadow/.git", ["*.large"], "tmp/")
        const [, written] = vi.mocked(fs.writeFile).mock.calls[0] ?? []
        vi.mocked(fs.readFile).mockResolvedValueOnce(written as string)

        const second = await writeExcludesFile("C:/shadow/.git", ["*.large"], "tmp/")

        expect(first.changed).toBe(true)
        expect(second.changed).toBe(false)
    })

    it("reports a changed ruleset when the patterns differ from the persisted excludes", async () => {
        await writeExcludesFile("C:/shadow/.git", ["*.large"], "tmp/")
        const [, written] = vi.mocked(fs.writeFile).mock.calls[0] ?? []
        vi.mocked(fs.readFile).mockResolvedValueOnce(written as string)

        const result = await writeExcludesFile("C:/shadow/.git", ["*.large"], "tmp/\nbuild-output/")

        expect(result.changed).toBe(true)
    })
})
