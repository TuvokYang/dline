import { Controller } from "@core/controller"
import * as openFileIntegration from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/dline/common"
import * as pathUtils from "@utils/path"
import { expect } from "chai"
import * as path from "path"
import { afterEach, beforeEach, describe, it, vi, expect as vitestExpect } from "vitest"
// sinon import removed
import { Logger } from "@/shared/services/Logger"
import { openFileRelativePath } from "../openFileRelativePath"

describe("openFileRelativePath", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let mockController: Controller
    let openFileIntegrationStub: any /* sinon.SinonStub → vitest */
    let getWorkspacePathStub: any /* sinon.SinonStub → vitest */
    let consoleErrorStub: any /* sinon.SinonStub → vitest */

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }

        // Create a mock controller
        mockController = {} as any

        // Stub the openFileIntegration function
        openFileIntegrationStub = vi.spyOn(openFileIntegration, "openFile")

        // Stub getWorkspacePath utility
        getWorkspacePathStub = vi.spyOn(pathUtils, "getWorkspacePath")

        // Stub console.error to prevent test output pollution
        consoleErrorStub = vi.spyOn(Logger, "error")
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("should return Empty response on successful execution", async () => {
        getWorkspacePathStub.mockResolvedValue("/workspace")

        const request = StringRequest.create({
            value: "src/test.ts",
        })

        const result = await openFileRelativePath(mockController, request)

        expect(result).to.deep.equal(Empty.create())
    })

    it("should call openFileIntegration with absolute path when relative path is provided", async () => {
        const workspacePath = "/workspace"
        const relativePath = "src/components/Test.tsx"
        const expectedAbsolutePath = path.resolve(workspacePath, relativePath)

        getWorkspacePathStub.mockResolvedValue(workspacePath)

        const request = StringRequest.create({
            value: relativePath,
        })

        await openFileRelativePath(mockController, request)

        vitestExpect(openFileIntegrationStub).toHaveBeenCalledWith(expectedAbsolutePath, false, false, undefined)
    })

    it("should not call openFileIntegration when path is invalid", async () => {
        getWorkspacePathStub.mockResolvedValue("/workspace")

        const invalidPaths = ["", undefined]

        for (const invalidPath of invalidPaths) {
            const request = StringRequest.create({
                value: invalidPath,
            })

            await openFileRelativePath(mockController, request)

            expect(openFileIntegrationStub.mock.calls.length > 0).to.be.false
            openFileIntegrationStub.mockClear()
        }
    })

    it("should return Empty and log error when no workspace path is available", async () => {
        const noWorkspaceScenarios = [null, undefined]

        for (const workspaceValue of noWorkspaceScenarios) {
            getWorkspacePathStub.mockResolvedValue(workspaceValue)
            consoleErrorStub.mockClear()

            const request = StringRequest.create({
                value: "src/test.ts",
            })

            const result = await openFileRelativePath(mockController, request)

            expect(result).to.deep.equal(Empty.create())
            expect(consoleErrorStub.mock.calls.length > 0).to.be.true
            expect(openFileIntegrationStub.mock.calls.length > 0).to.be.false
        }
    })

    it("should handle nested directory paths", async () => {
        const workspacePath = "/workspace"
        const relativePath = "src/components/ui/Button/Button.tsx"
        const expectedAbsolutePath = path.resolve(workspacePath, relativePath)

        getWorkspacePathStub.mockResolvedValue(workspacePath)

        const request = StringRequest.create({
            value: relativePath,
        })

        await openFileRelativePath(mockController, request)

        vitestExpect(openFileIntegrationStub).toHaveBeenCalledWith(expectedAbsolutePath, false, false, undefined)
    })
})
