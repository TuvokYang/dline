import * as diskStorage from "@core/storage/disk"
import * as remoteConfigFetch from "@core/storage/remote-config/fetch"
import * as remoteConfigUtils from "@core/storage/remote-config/utils"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import * as assert from "assert"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
// sinon import removed: using vitest globals
import { ClineAccountService } from "@/services/account/ClineAccountService"
import { AuthService } from "@/services/auth/AuthService"

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

describe("fetchRemoteConfig", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let accountService: ClineAccountService
    let authServiceStub: Partial<AuthService>
    let fetchUserRemoteConfigStub: any /* sinon.SinonStub → vitest */
    let isRemoteConfigEnabledStub: any /* sinon.SinonStub → vitest */

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }
        authServiceStub = {}
        vi.spyOn(AuthService, "getInstance").mockReturnValue(authServiceStub as AuthService)
        accountService = new ClineAccountService()
        vi.spyOn(ClineAccountService, "getInstance").mockReturnValue(accountService)
        fetchUserRemoteConfigStub = vi.spyOn(accountService, "fetchUserRemoteConfig")
        isRemoteConfigEnabledStub = vi.spyOn(remoteConfigUtils, "isRemoteConfigEnabled").mockReturnValue(true)
        vi.spyOn(remoteConfigUtils, "applyRemoteConfig").mockResolvedValue()
        vi.spyOn(remoteConfigUtils, "clearRemoteConfig")
        vi.spyOn(diskStorage, "writeRemoteConfigToCache").mockResolvedValue()
        vi.spyOn(diskStorage, "readRemoteConfigFromCache").mockResolvedValue({ version: "v1" })
        vi.spyOn(diskStorage, "deleteRemoteConfigFromCache").mockResolvedValue()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("switches org when not in the chosen org", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-current",
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: '{"version":"v1"}',
            organizations: [{ organizationId: "org-target", name: "Target Org" }],
        })

        const controller = {
            accountService: { switchAccount: vi.fn().mockResolvedValue(undefined) },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        assert.strictEqual(controller.accountService.switchAccount.mock.calls.length, 1)
        assert.strictEqual(controller.accountService.switchAccount.mock.calls[0][0], "org-target")
        assert.ok((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1)
    })

    it("skips switchAccount when already in the chosen org", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-target",
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: '{"version":"v1"}',
            organizations: [{ organizationId: "org-target", name: "Target Org" }],
        })

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        assert.strictEqual(controller.accountService.switchAccount.mock.calls.length, 0)
        assert.ok((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1)
    })

    it("uses discoveredValue inline and skips org-level config fetch", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-target",
            getAuthToken: () => Promise.resolve("token"),
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: '{"version":"v1"}',
            organizations: [{ organizationId: "org-target", name: "Target Org" }],
        })

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        assert.ok((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1)
        // writeRemoteConfigToCache is called with the parsed config, proving inline parse succeeded.
        // If it had fallen through to fetchRemoteConfigForOrganization, it would need getAuthToken
        // and make an HTTP call — but no axios stub is set up, so the test would fail.
        assert.ok((diskStorage.writeRemoteConfigToCache as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1)
    })

    it("falls back to org-level fetch when discoveredValue fails to parse", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-target",
            getAuthToken: () => Promise.resolve(null),
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: "not valid json{{{",
            organizations: [{ organizationId: "org-target", name: "Target Org" }],
        })

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        // Parse failed → fetchRemoteConfigForOrganization → no auth → cache fallback
        assert.ok((diskStorage.readRemoteConfigFromCache as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0)
        assert.ok((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1)
    })

    it("does not switch org when resolve fails", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-current",
            getAuthToken: () => Promise.resolve(null),
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: "not valid json{{{",
            organizations: [{ organizationId: "org-target", name: "Target Org" }],
        })

        // Both inline parse and org-level fetch fail (no auth → no fetch), cache is empty
        ;(diskStorage.readRemoteConfigFromCache as any) /* sinon.SinonStub → vitest */
            .mockResolvedValue(undefined)

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        // Config resolution failed — user should stay in their current org
        assert.strictEqual(controller.accountService.switchAccount.mock.calls.length, 0)
        assert.ok((remoteConfigUtils.clearRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0)
        assert.strictEqual((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length, 0)
    })

    it("falls back to next locally-allowed org when backend org is opted-out", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-3",
            getAuthToken: () => Promise.resolve("token"),
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-1",
            value: '{"version":"v1"}',
            organizations: [
                { organizationId: "org-1", name: "Org 1" },
                { organizationId: "org-2", name: "Org 2" },
                { organizationId: "org-3", name: "Org 3" },
            ],
        })
        isRemoteConfigEnabledStub.mockImplementation((orgId: string) => orgId === "org-3")
        // Fallback org has no discoveredValue, so it will go through fetchRemoteConfigForOrganization
        // which needs auth → will fall back to cache
        ;(diskStorage.readRemoteConfigFromCache as any) /* sinon.SinonStub → vitest */
            .mockResolvedValue({ version: "v1" })

        const controller = {
            accountService: { switchAccount: vi.fn().mockResolvedValue(undefined) },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        assert.ok((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1)
    })

    it("clears remote config when all orgs are locally opted-out", async () => {
        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-1",
            value: '{"version":"v1"}',
            organizations: [
                { organizationId: "org-1", name: "Org 1" },
                { organizationId: "org-2", name: "Org 2" },
            ],
        })
        isRemoteConfigEnabledStub.mockClear()
        isRemoteConfigEnabledStub.mockReturnValue(false)

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        assert.ok((remoteConfigUtils.clearRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0)
        assert.strictEqual(controller.accountService.switchAccount.mock.calls.length, 0)
        assert.strictEqual((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length, 0)
    })

    it("calls clearRemoteConfig when discovery returns no qualifying org", async () => {
        fetchUserRemoteConfigStub.mockResolvedValue(undefined)

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        assert.ok((remoteConfigUtils.clearRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0)
        assert.strictEqual(controller.accountService.switchAccount.mock.calls.length, 0)
        assert.strictEqual((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length, 0)
    })

    it("clears remote config when isRemoteConfigEnabled toggled off mid-flight", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-target",
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: '{"version":"v1"}',
            organizations: [{ organizationId: "org-target", name: "Target Org" }],
        })

        isRemoteConfigEnabledStub.mockClear()
        isRemoteConfigEnabledStub.mockReturnValueOnce(true).mockReturnValueOnce(false)

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        assert.ok((diskStorage.writeRemoteConfigToCache as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1)
        assert.ok((remoteConfigUtils.clearRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0)
        assert.strictEqual((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length, 0)
    })

    it("preserves existing config on unexpected network error", async () => {
        fetchUserRemoteConfigStub.mockRejectedValue(new Error("network failure"))

        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        // Transient errors should NOT clear existing remote config
        assert.strictEqual((remoteConfigUtils.clearRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length, 0)
        assert.strictEqual(controller.postStateToWebview.mock.calls.length, 0)
    })

    it("flushes active Task freshness when remote Rules, Workflows, or Skills change", async () => {
        Object.assign(authServiceStub, { getActiveOrganizationId: () => "org-target" })
        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: JSON.stringify({
                version: "v1",
                globalRules: [{ name: "policy", alwaysEnabled: true, contents: "RULES_V2" }],
                globalWorkflows: [{ name: "release", alwaysEnabled: false, contents: "WORKFLOW_V2" }],
                globalSkills: [{ name: "review", alwaysEnabled: false, contents: "SKILL_V2" }],
            }),
        })
        const remoteState: Record<string, unknown> = {
            remoteGlobalRules: [{ name: "policy", alwaysEnabled: true, contents: "RULES_V1" }],
            remoteGlobalWorkflows: [{ name: "release", alwaysEnabled: false, contents: "WORKFLOW_V1" }],
            remoteGlobalSkills: [{ name: "review", alwaysEnabled: false, contents: "SKILL_V1" }],
        }
        const globalState = new Map<string, unknown>([
            ["remoteWorkflowToggles", { release: true }],
            ["remoteSkillsToggles", { review: true }],
        ])
        vi.mocked(remoteConfigUtils.applyRemoteConfig).mockImplementationOnce(async (config) => {
            remoteState.remoteGlobalRules = config.globalRules ?? []
            remoteState.remoteGlobalWorkflows = config.globalWorkflows ?? []
            remoteState.remoteGlobalSkills = config.globalSkills ?? []
        })
        const flushPromptFreshnessInvalidation = vi.fn().mockResolvedValue(undefined)
        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: {
                setSecret: vi.fn(),
                getRemoteConfigSettings: () => remoteState,
                getGlobalStateKey: (key: string) => globalState.get(key),
            },
            mcpHub: {},
            task: createSessionFixture({ owners: { prompt: { flush: flushPromptFreshnessInvalidation } } }),
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        expect(flushPromptFreshnessInvalidation).toHaveBeenCalledWith("remote_config")
        expect(controller.postStateToWebview).not.toHaveBeenCalled()
    })

    it("does not re-evaluate freshness for an equivalent periodic remote config fetch", async () => {
        Object.assign(authServiceStub, { getActiveOrganizationId: () => "org-target" })
        const rules = [{ name: "policy", alwaysEnabled: true, contents: "RULES_V1" }]
        const workflows = [{ name: "release", alwaysEnabled: false, contents: "WORKFLOW_V1" }]
        const skills = [{ name: "review", alwaysEnabled: false, contents: "SKILL_V1" }]
        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: JSON.stringify({ version: "v1", globalRules: rules, globalWorkflows: workflows, globalSkills: skills }),
        })
        const remoteState: Record<string, unknown> = {
            remoteGlobalRules: rules,
            remoteGlobalWorkflows: workflows,
            remoteGlobalSkills: skills,
        }
        const globalState = new Map<string, unknown>([
            ["remoteWorkflowToggles", { release: true }],
            ["remoteSkillsToggles", { review: true }],
        ])
        vi.mocked(remoteConfigUtils.applyRemoteConfig).mockImplementationOnce(async (config) => {
            remoteState.remoteGlobalRules = config.globalRules ?? []
            remoteState.remoteGlobalWorkflows = config.globalWorkflows ?? []
            remoteState.remoteGlobalSkills = config.globalSkills ?? []
        })
        const flushPromptFreshnessInvalidation = vi.fn().mockResolvedValue(undefined)
        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: {
                setSecret: vi.fn(),
                getRemoteConfigSettings: () => remoteState,
                getGlobalStateKey: (key: string) => globalState.get(key),
            },
            mcpHub: {},
            task: createSessionFixture({ owners: { prompt: { flush: flushPromptFreshnessInvalidation } } }),
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        expect(flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
        expect(controller.postStateToWebview).toHaveBeenCalledOnce()
    })

    it("preserves existing config when switchAccount rejects", async () => {
        Object.assign(authServiceStub, {
            getActiveOrganizationId: () => "org-current",
        })

        fetchUserRemoteConfigStub.mockResolvedValue({
            organizationId: "org-target",
            value: '{"version":"v1"}',
            organizations: [{ organizationId: "org-target", name: "Target Org" }],
        })

        const controller = {
            accountService: { switchAccount: vi.fn().mockRejectedValue(new Error("switch failed")) },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        await remoteConfigFetch.fetchRemoteConfig(controller as any)

        // switchAccount failure should NOT clear existing remote config
        assert.strictEqual((remoteConfigUtils.clearRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length, 0)
        assert.strictEqual((remoteConfigUtils.applyRemoteConfig as any) /* sinon.SinonStub → vitest */.mock.calls.length, 0)
    })

    it("coalesces concurrent refresh requests for the same controller", async () => {
        const discovery = deferred<undefined>()
        fetchUserRemoteConfigStub.mockReturnValue(discovery.promise)
        const controller = {
            accountService: { switchAccount: vi.fn() },
            stateManager: { setSecret: vi.fn() },
            mcpHub: {},
            postStateToWebview: vi.fn(),
        }

        const first = remoteConfigFetch.fetchRemoteConfig(controller as any)
        const second = remoteConfigFetch.fetchRemoteConfig(controller as any)

        expect(second).toBe(first)
        expect(fetchUserRemoteConfigStub).toHaveBeenCalledOnce()

        discovery.resolve(undefined)
        await Promise.all([first, second])
        expect(remoteConfigUtils.clearRemoteConfig).toHaveBeenCalledOnce()
    })
})
