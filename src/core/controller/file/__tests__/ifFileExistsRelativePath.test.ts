import { Controller } from "@core/controller"
import { WorkspaceRootManager } from "@core/workspace"
import { VcsType } from "@shared/multi-root/types"
import { BooleanResponse, StringRequest } from "@shared/proto/dline/common"
import * as pathUtils from "@utils/path"
import { expect } from "chai"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
// sinon import removed
import { ifFileExistsRelativePath } from "../ifFileExistsRelativePath"

describe("ifFileExistsRelativePath", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let mockController: Controller
    let getWorkspacePathStub: any /* sinon.SinonStub → vitest */

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }

        // Create a mock controller
        mockController = {} as any

        // Stub getWorkspacePath utility
        getWorkspacePathStub = vi.spyOn(pathUtils, "getWorkspacePath")
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("should return BooleanResponse with boolean value", async () => {
        getWorkspacePathStub.mockResolvedValue("/workspace")

        const request = StringRequest.create({
            value: "src/test.ts",
        })

        const result = await ifFileExistsRelativePath(mockController, request)

        // The result should be a BooleanResponse object
        expect(result).to.have.property("value")
        expect(typeof result.value).to.equal("boolean")
    })

    it("should return false when no workspace path is available", async () => {
        const noWorkspaceScenarios = [null, undefined]

        for (const workspaceValue of noWorkspaceScenarios) {
            getWorkspacePathStub.mockResolvedValue(workspaceValue)

            const request = StringRequest.create({
                value: "src/test.ts",
            })

            const result = await ifFileExistsRelativePath(mockController, request)

            expect(result).to.deep.equal(BooleanResponse.create({ value: false }))
        }
    })

    it("should return false when path is invalid", async () => {
        getWorkspacePathStub.mockResolvedValue("/workspace")

        const invalidPaths = ["", undefined]

        for (const invalidPath of invalidPaths) {
            const request = StringRequest.create({
                value: invalidPath,
            })

            const result = await ifFileExistsRelativePath(mockController, request)

            expect(result).to.deep.equal(BooleanResponse.create({ value: false }))
        }
    })

    it("should handle valid relative paths correctly", async () => {
        getWorkspacePathStub.mockResolvedValue("/workspace")

        // Test with valid workspace-relative paths only
        const validPaths = ["src/file.ts", "./src/file.ts", "package.json", ".gitignore", "src/components/ui/Button/Button.tsx"]

        for (const testPath of validPaths) {
            const request = StringRequest.create({
                value: testPath,
            })

            const result = await ifFileExistsRelativePath(mockController, request)

            // Each should return a BooleanResponse
            expect(result).to.have.property("value")
            expect(typeof result.value).to.equal("boolean")
        }

        // Verify that getWorkspacePath was called for each path
        expect(getWorkspacePathStub.mock.calls.length).to.equal(validPaths.length)
    })

    describe("multi-root workspace links", () => {
        let tempDir: string
        let primaryRoot: string
        let secondaryRoot: string

        beforeEach(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dline-link-exists-"))
            primaryRoot = path.join(tempDir, "dline")
            secondaryRoot = path.join(tempDir, "dline-web")
            fs.mkdirSync(path.join(secondaryRoot, "app"), { recursive: true })
            fs.mkdirSync(primaryRoot, { recursive: true })
            fs.writeFileSync(path.join(secondaryRoot, "app", "main.ts"), "export {}\n")

            const manager = new WorkspaceRootManager(
                [
                    { path: primaryRoot, name: "dline", vcs: VcsType.None },
                    { path: secondaryRoot, name: "dline-web", vcs: VcsType.None },
                ],
                0,
            )
            mockController = { ensureWorkspaceManager: vi.fn(async () => manager) } as unknown as Controller
            getWorkspacePathStub.mockResolvedValue(primaryRoot)
        })

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true })
        })

        it("finds a file named by a hinted link with a line in the hinted root", async () => {
            const result = await ifFileExistsRelativePath(
                mockController,
                StringRequest.create({ value: "@dline-web:app/main.ts:3" }),
            )

            expect(result).to.deep.equal(BooleanResponse.create({ value: true }))
        })

        it("does not find the same path unhinted when it only exists in another root", async () => {
            const result = await ifFileExistsRelativePath(mockController, StringRequest.create({ value: "app/main.ts" }))

            expect(result).to.deep.equal(BooleanResponse.create({ value: false }))
        })
    })
})
