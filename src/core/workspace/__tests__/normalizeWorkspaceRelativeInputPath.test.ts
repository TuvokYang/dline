import { expect } from "chai"
import { describe, it } from "vitest"
import { normalizeWorkspaceRelativeInputPath } from "../utils/normalizeWorkspaceRelativeInputPath"

describe("normalizeWorkspaceRelativeInputPath", () => {
    describe("win32 platform", () => {
        const platform = "win32"

        it("should strip a single leading /", () => {
            expect(normalizeWorkspaceRelativeInputPath("/src/a.ts", platform)).to.equal("src/a.ts")
        })

        it("should strip a single leading \\", () => {
            expect(normalizeWorkspaceRelativeInputPath("\\src\\a.ts", platform)).to.equal("src\\a.ts")
        })

        it("should preserve drive-letter absolute paths (C:\\)", () => {
            expect(normalizeWorkspaceRelativeInputPath("C:\\foo\\bar", platform)).to.equal("C:\\foo\\bar")
        })

        it("should preserve drive-letter absolute paths (C:/)", () => {
            expect(normalizeWorkspaceRelativeInputPath("C:/foo/bar", platform)).to.equal("C:/foo/bar")
        })

        it("should strip leading / from drive path (/E:/x)", () => {
            expect(normalizeWorkspaceRelativeInputPath("/E:/workspace/src/file.ts", platform)).to.equal(
                "E:/workspace/src/file.ts",
            )
        })

        it("should preserve UNC paths (\\\\)", () => {
            expect(normalizeWorkspaceRelativeInputPath("\\\\server\\share\\a.txt", platform)).to.equal("\\\\server\\share\\a.txt")
        })

        it("should preserve UNC paths (//)", () => {
            expect(normalizeWorkspaceRelativeInputPath("//server/share/a.txt", platform)).to.equal("//server/share/a.txt")
        })

        it("should preserve workspace hints (@ws:path)", () => {
            expect(normalizeWorkspaceRelativeInputPath("@frontend:src/index.ts", platform)).to.equal("@frontend:src/index.ts")
        })

        it("should preserve workspace hints with leading / in path (@ws:/path)", () => {
            // The helper preserves the full hint; caller must parse+renormalize the relPath
            expect(normalizeWorkspaceRelativeInputPath("@frontend:/src/index.ts", platform)).to.equal("@frontend:/src/index.ts")
        })

        it("should not change normal relative paths", () => {
            expect(normalizeWorkspaceRelativeInputPath("src/a.ts", platform)).to.equal("src/a.ts")
        })

        it("should handle empty string", () => {
            expect(normalizeWorkspaceRelativeInputPath("", platform)).to.equal("")
        })
    })

    describe("POSIX platforms (linux/darwin)", () => {
        it("should preserve /src/a.ts as absolute path on linux", () => {
            expect(normalizeWorkspaceRelativeInputPath("/src/a.ts", "linux")).to.equal("/src/a.ts")
        })

        it("should preserve /src/a.ts as absolute path on darwin", () => {
            expect(normalizeWorkspaceRelativeInputPath("/src/a.ts", "darwin")).to.equal("/src/a.ts")
        })

        it("should preserve relative paths on linux", () => {
            expect(normalizeWorkspaceRelativeInputPath("src/a.ts", "linux")).to.equal("src/a.ts")
        })

        it("should preserve relative paths on darwin", () => {
            expect(normalizeWorkspaceRelativeInputPath("src/a.ts", "darwin")).to.equal("src/a.ts")
        })
    })

    describe("workspace hint + re-normalize pattern", () => {
        it("should preserve @hint so caller can parse and re-normalize relPath (win32)", () => {
            // Step 1: normalizeInput preserves the @ prefix
            const input = "@frontend:/src/App.tsx"
            const normalizedInput = normalizeWorkspaceRelativeInputPath(input, "win32")
            expect(normalizedInput).to.equal("@frontend:/src/App.tsx")

            // Step 2: caller parses out the hint (simulate parseWorkspaceInlinePath)
            const colonIdx = normalizedInput.indexOf(":")
            const relPath = normalizedInput.slice(colonIdx + 1) // "/src/App.tsx"

            // Step 3: normalize again to strip leading "/" from relPath
            const parsedPath = normalizeWorkspaceRelativeInputPath(relPath, "win32")
            expect(parsedPath).to.equal("src/App.tsx")
        })

        it("should handle @hint without leading slash in path (win32)", () => {
            const input = "@backend:src/main.py"
            const normalizedInput = normalizeWorkspaceRelativeInputPath(input, "win32")
            expect(normalizedInput).to.equal("@backend:src/main.py")

            const colonIdx = normalizedInput.indexOf(":")
            const relPath = normalizedInput.slice(colonIdx + 1)
            const parsedPath = normalizeWorkspaceRelativeInputPath(relPath, "win32")
            expect(parsedPath).to.equal("src/main.py")
        })

        it("should be no-op on POSIX for workspace hints", () => {
            const input = "@frontend:/src/App.tsx"
            expect(normalizeWorkspaceRelativeInputPath(input, "linux")).to.equal("@frontend:/src/App.tsx")
        })
    })

    describe("default platform (process.platform)", () => {
        it("should not throw with default platform", () => {
            expect(() => normalizeWorkspaceRelativeInputPath("src/a.ts")).to.not.throw()
        })
    })
})
