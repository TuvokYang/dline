import { Controller } from "@core/controller"
import type { ExtensionState } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/dline/common"
import { describe, expect, it, vi } from "vitest"
import { getLatestState } from "../getLatestState"

describe("getLatestState", () => {
    it("initializes workspace roots before building a taskless state snapshot", async () => {
        const controller = Object.create(Controller.prototype) as Controller
        const ensureWorkspaceManager = vi.spyOn(controller, "ensureWorkspaceManager").mockResolvedValue(undefined)
        const getState = vi.spyOn(controller, "getStateToPostToWebview").mockResolvedValue({
            stateRevision: 1,
            workspaceRoots: [{ name: "workspace", path: "C:\\workspace" }],
        } as ExtensionState)
        vi.spyOn(controller, "getAccountUsage").mockReturnValue(undefined)

        const response = await getLatestState(controller, EmptyRequest.create())

        expect(ensureWorkspaceManager).toHaveBeenCalledOnce()
        expect(ensureWorkspaceManager.mock.invocationCallOrder[0]).toBeLessThan(getState.mock.invocationCallOrder[0])
        expect(JSON.parse(response.stateJson)).toMatchObject({
            workspaceRoots: [{ name: "workspace", path: "C:\\workspace" }],
        })
    })
})
