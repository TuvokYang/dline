import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { CreateSubagentRequest, DeleteSubagentRequest } from "@shared/proto/dline/file"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { createSubagentFile } from "../createSubagentFile"
import { deleteSubagentFile } from "../deleteSubagentFile"

vi.mock("../openFile", () => ({
    openFile: vi.fn().mockResolvedValue(undefined),
}))

describe("Subagent freshness mutations", () => {
    let tempDirectory: string
    let workspaceDirectory: string

    beforeEach(async () => {
        tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-freshness-mutation-"))
        workspaceDirectory = path.join(tempDirectory, "workspace")
        await fs.mkdir(workspaceDirectory, { recursive: true })
        vi.spyOn(HostProvider, "workspace", "get").mockReturnValue({
            getWorkspacePaths: vi.fn().mockResolvedValue({ paths: [workspaceDirectory] }),
        } as never)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(tempDirectory, { recursive: true, force: true })
    })

    function createController() {
        const localToggles: Record<string, boolean> = {}
        const flushPromptFreshnessInvalidation = vi.fn().mockResolvedValue(undefined)
        const postStateToWebview = vi.fn().mockResolvedValue(undefined)
        return {
            controller: {
                stateManager: {
                    getGlobalSettingsKey: vi.fn().mockReturnValue({}),
                    // Locally discovered subagents read their overrides from the scope
                    // chain now, so the fake exposes the scoped reader instead of the
                    // retired workspace-state map.
                    getScopedCapabilityToggles: vi
                        .fn()
                        .mockImplementation((scope: string) => (scope === "workspace" ? localToggles : {})),
                    mutateScopedCapabilityToggles: vi.fn().mockResolvedValue(localToggles),
                    setWorkspaceState: vi.fn(),
                },
                task: createSessionFixture({ owners: { prompt: { flush: flushPromptFreshnessInvalidation } } }),
                postStateToWebview,
            } as never,
            flushPromptFreshnessInvalidation,
            postStateToWebview,
        }
    }

    it("flushes active Task freshness after creating and deleting a subagent", async () => {
        const fixture = createController()
        const createRequest = CreateSubagentRequest.create({ subagentName: "reviewer", isGlobal: false })

        await createSubagentFile(fixture.controller, createRequest)
        const subagentPath = path.join(workspaceDirectory, ".agents", "subagents", "reviewer.yml")
        expect(await fs.readFile(subagentPath, "utf8")).toContain("name: reviewer")
        expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledWith("capability_mutation")
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()

        await deleteSubagentFile(fixture.controller, DeleteSubagentRequest.create({ subagentPath, isGlobal: false }))
        await expect(fs.access(subagentPath)).rejects.toThrow()
        expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledTimes(2)
    })

    it("does not emit a mutation signal when no subagent mutation is committed", async () => {
        const fixture = createController()
        const createRequest = CreateSubagentRequest.create({ subagentName: "reviewer", isGlobal: false })
        await createSubagentFile(fixture.controller, createRequest)
        fixture.flushPromptFreshnessInvalidation.mockClear()

        await createSubagentFile(fixture.controller, createRequest)
        expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()

        await expect(
            deleteSubagentFile(
                fixture.controller,
                DeleteSubagentRequest.create({
                    subagentPath: path.join(workspaceDirectory, ".agents", "subagents", "missing.yml"),
                    isGlobal: false,
                }),
            ),
        ).rejects.toThrow("Subagent file does not exist")
        expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
    })
})
