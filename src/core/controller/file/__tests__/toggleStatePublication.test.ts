import { RuleScope, ToggleSkillRequest, ToggleWorkflowRequest } from "@shared/proto/dline/file"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toggleSkill } from "../toggleSkill"
import { toggleWorkflow } from "../toggleWorkflow"

const mocks = vi.hoisted(() => ({
    setCapabilityEnabled: vi.fn(),
    setGlobalCapabilityEnabled: vi.fn(),
    readScopedToggles: vi.fn(),
    mergeScopedToggles: vi.fn(),
}))

vi.mock("@core/storage/settings/capability-toggle-store", () => ({
    setCapabilityEnabled: mocks.setCapabilityEnabled,
    readScopedToggles: mocks.readScopedToggles,
    mergeScopedToggles: mocks.mergeScopedToggles,
}))
vi.mock("@core/storage/settings/global-capability-settings", () => ({
    setGlobalCapabilityEnabled: mocks.setGlobalCapabilityEnabled,
}))

/**
 * A toggle answers over its own RPC, so it must not trigger a full state publication.
 *
 * Publishing the whole extension state on every switch made the webview recompute
 * and re-render unrelated sections, which is what made toggling feel slow.
 */
describe("Capability toggle state publication", () => {
    function createController() {
        const postStateToWebview = vi.fn().mockResolvedValue(undefined)
        return {
            controller: {
                stateManager: {
                    getGlobalSettingsKey: vi.fn().mockReturnValue({}),
                    getWorkspaceStateKey: vi.fn().mockReturnValue({}),
                    getGlobalStateKey: vi.fn().mockReturnValue({}),
                    setGlobalState: vi.fn(),
                    hasWorkspaceScope: true,
                },
                task: undefined,
                postStateToWebview,
            } as never,
            postStateToWebview,
        }
    }

    beforeEach(() => {
        mocks.setCapabilityEnabled.mockReset().mockResolvedValue({ "skills/review": false })
        mocks.setGlobalCapabilityEnabled.mockReset().mockResolvedValue({})
        mocks.readScopedToggles.mockReset().mockReturnValue({ global: {}, workspace: {}, task: {} })
        mocks.mergeScopedToggles.mockReset().mockReturnValue({})
    })

    it("answers a local skill toggle without publishing the whole state", async () => {
        const fixture = createController()

        const response = await toggleSkill(
            fixture.controller,
            ToggleSkillRequest.create({ skillPath: "E:/ws/.agents/skills/review/SKILL.md", isGlobal: false, enabled: false }),
        )

        expect(mocks.setCapabilityEnabled).toHaveBeenCalledOnce()
        expect(response.localSkillsToggles).toEqual({ "skills/review": false })
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
    })

    it("answers a local workflow toggle without publishing the whole state", async () => {
        const fixture = createController()
        mocks.setCapabilityEnabled.mockResolvedValue({ "workflows/release": false })

        const response = await toggleWorkflow(
            fixture.controller,
            ToggleWorkflowRequest.create({
                workflowPath: "E:/ws/.dline/workflows/release.md",
                enabled: false,
                scope: RuleScope.LOCAL,
            }),
        )

        expect(response.toggles).toEqual({ "workflows/release": false })
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
    })

    it("answers a global skill toggle without publishing the whole state", async () => {
        const fixture = createController()
        mocks.setGlobalCapabilityEnabled.mockResolvedValue({ "global-skill": false })

        const response = await toggleSkill(
            fixture.controller,
            ToggleSkillRequest.create({ skillPath: "C:/docs/skills/audit/SKILL.md", isGlobal: true, enabled: false }),
        )

        expect(mocks.setCapabilityEnabled).not.toHaveBeenCalled()
        expect(response.globalSkillsToggles).toEqual({ "global-skill": false })
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
    })

    it("answers a remote skill toggle without publishing the whole state", async () => {
        const fixture = createController()

        const response = await toggleSkill(
            fixture.controller,
            ToggleSkillRequest.create({ skillPath: "remote:audit", isGlobal: false, enabled: false }),
        )

        expect(mocks.setCapabilityEnabled).not.toHaveBeenCalled()
        expect(response.remoteSkillsToggles).toEqual({ audit: false })
        expect(fixture.postStateToWebview).not.toHaveBeenCalled()
    })
})
