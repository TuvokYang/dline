import { Controller } from "@core/controller"
import { WorkspaceRootManager } from "@core/workspace"
import * as openFileIntegration from "@integrations/misc/open-file"
import { VcsType } from "@shared/multi-root/types"
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

    describe("multi-root workspace links", () => {
        const primaryRoot = "/workspaces/dline"
        const secondaryRoot = "/workspaces/dline-web"
        let ensureWorkspaceManager: ReturnType<typeof vi.fn>

        beforeEach(() => {
            const manager = new WorkspaceRootManager(
                [
                    { path: primaryRoot, name: "dline", vcs: VcsType.Git },
                    { path: secondaryRoot, name: "dline-web", vcs: VcsType.Git },
                ],
                0,
            )
            ensureWorkspaceManager = vi.fn(async () => manager)
            mockController = { ensureWorkspaceManager } as unknown as Controller
            getWorkspacePathStub.mockResolvedValue(primaryRoot)
            openFileIntegrationStub.mockResolvedValue(undefined)
        })

        it("opens a hinted link with a line in the named workspace root", async () => {
            await openFileRelativePath(
                mockController,
                StringRequest.create({ value: "@dline-web:app/backend/otel/content-policy.test.ts:31" }),
            )

            vitestExpect(openFileIntegrationStub).toHaveBeenCalledWith(
                path.join(secondaryRoot, "app/backend/otel/content-policy.test.ts"),
                false,
                false,
                31,
            )
        })

        it("resolves an unhinted link against the primary root without detecting roots", async () => {
            await openFileRelativePath(mockController, StringRequest.create({ value: "src/index.ts:4" }))

            vitestExpect(openFileIntegrationStub).toHaveBeenCalledWith(path.resolve(primaryRoot, "src/index.ts"), false, false, 4)
            vitestExpect(ensureWorkspaceManager).not.toHaveBeenCalled()
        })
    })
})
