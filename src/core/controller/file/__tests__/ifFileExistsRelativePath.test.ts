import { Controller } from "@core/controller"
import { BooleanResponse, StringRequest } from "@shared/proto/dline/common"
import * as pathUtils from "@utils/path"
import { expect } from "chai"
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
})
