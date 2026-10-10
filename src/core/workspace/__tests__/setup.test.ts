import type { WorkspaceRoot } from "@shared/multi-root/types"
import { VcsType } from "@shared/multi-root/types"
import { expect } from "chai"
import * as path from "path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
// sinon import removed: using vitest globals
import { HostProvider } from "@/hosts/host-provider"
import * as telemetry from "@/services/telemetry"
import * as pathUtils from "@/utils/path"
import { setupWorkspaceManager } from "../setup"
import { WorkspaceRootManager } from "../WorkspaceRootManager"

describe("setupWorkspaceManager", () => {
    const sandbox = { mockRestore: () => {} }
    let fakeTelemetry: {
        captureWorkspaceInitialized: any /* sinon.SinonStub → vitest */
        captureWorkspaceInitError: any /* sinon.SinonStub → vitest */
    }

    const cwd = "/Users/test/project"
    const defaultRoots: WorkspaceRoot[] = [
        { path: "/ws/root1", name: "root1", vcs: VcsType.Git, commitHash: "abc" },
        { path: "/ws/root2", name: "root2", vcs: VcsType.None },
    ]

    // Minimal stateManager stub with behavior we assert
    const makeStateManager = ({
        multiRootEnabled = true,
        savedRoots,
        savedPrimaryIndex = 0,
    }: {
        multiRootEnabled?: boolean
        savedRoots?: WorkspaceRoot[]
        savedPrimaryIndex?: number
    }) => {
        const state: { roots?: WorkspaceRoot[]; primaryIndex?: number } = {}
        return {
            getGlobalStateKey: (key: string) => {
                switch (key) {
                    case "multiRootEnabled":
                        return multiRootEnabled
                    case "workspaceRoots":
                        return savedRoots
                    case "primaryRootIndex":
                        return savedPrimaryIndex
                    default:
                        return undefined
                }
            },
            setGlobalState: (key: string, value: any) => {
                switch (key) {
                    case "workspaceRoots":
                        state.roots = value
                        break
                    case "primaryRootIndex":
                        state.primaryIndex = value
                        break
                }
            },
            // for assertions
            _state: state,
        }
    }

    beforeEach(() => {
        // Stub out path utils for stable behavior
        vi.spyOn(pathUtils, "getDesktopDir").mockReturnValue("/Users/test/Desktop" as any)
        vi.spyOn(pathUtils, "getCwd").mockResolvedValue(cwd as any)

        // Stub HostProvider window + workspace methods used by setup() error path
        Object.defineProperty(HostProvider, "window", {
            value: {
                showMessage: vi.fn().mockResolvedValue({ selectedOption: undefined }),
                openSettings: vi.fn().mockResolvedValue(undefined),
                getVisibleTabs: vi.fn().mockResolvedValue({ paths: [] }),
                getOpenTabs: vi.fn().mockResolvedValue({ paths: [] }),
            },
            writable: true,
            configurable: true,
        })

        Object.defineProperty(HostProvider, "workspace", {
            value: {
                getWorkspacePaths: vi.fn().mockResolvedValue({ paths: ["/ws/root1", "/ws/root2"] }),
            },
            writable: true,
            configurable: true,
        })

        // Telemetry stubs by replacing the exported proxy with a test double
        fakeTelemetry = {
            captureWorkspaceInitialized: vi.fn().mockResolvedValue(undefined),
            captureWorkspaceInitError: vi.fn().mockResolvedValue(undefined),
        }
        Object.defineProperty(telemetry, "telemetryService", {
            value: fakeTelemetry,
            writable: true,
            configurable: true,
        })

        // Stub WorkspaceRootManager.fromLegacyCwd to be deterministic
        vi.spyOn(WorkspaceRootManager, "fromLegacyCwd").mockImplementation(async (legacyCwd: string) => {
            // emulate single-root manager with cwd as only root
            return new WorkspaceRootManager([{ path: legacyCwd, name: path.basename(legacyCwd), vcs: VcsType.None }], 0)
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("initializes multi-root manager when multi-root is enabled and persists roots + primary index", async () => {
        const stateManager = makeStateManager({ multiRootEnabled: true })
        const detectRoots = vi.fn().mockResolvedValue(defaultRoots)

        // Multi-root workspace is now always enabled, no feature flag stub needed

        const manager = await setupWorkspaceManager({
            stateManager: stateManager as any,
            historyItem: undefined,
            detectRoots,
        })

        // detectRoots used
        expect(detectRoots.mock.calls.length === 1).to.equal(true)
        // manager configured with multi roots
        expect(manager.getRoots()).to.have.length(2)
        expect(manager.getPrimaryIndex()).to.equal(0)

        // persisted to state
        expect(stateManager._state.roots).to.have.length(2)
        expect(stateManager._state.primaryIndex).to.equal(0)

        // telemetry captured (skipped assertion in unit tests)
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls.length === 1).to.equal(true)
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls[0][0]).to.equal(2)
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls[0][1]).to.deep.equal(["git", "none"])
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls[0][3]).to.equal(true)
    })

    it("uses single-root cwd when history restore is disabled (historyItem present)", async () => {
        const savedRoots: WorkspaceRoot[] = [{ path: "/saved/root", name: "saved", vcs: VcsType.None }]
        const stateManager = makeStateManager({ multiRootEnabled: false, savedRoots, savedPrimaryIndex: 0 })
        const detectRoots = vi.fn().mockResolvedValue(defaultRoots) // not used

        const manager = await setupWorkspaceManager({
            stateManager: stateManager as any,
            historyItem: { id: "h1", ulid: "u1" } as any,
            detectRoots,
        })

        // detectRoots not used
        expect(detectRoots.mock.calls.length > 0).to.equal(false)
        // current design: single-root path uses cwd (stubbed earlier to "/Users/test/project")
        expect(manager.getRoots()).to.have.length(1)
        expect(manager.getRoots()[0].path).to.equal(cwd)
        // state persisted
        expect(stateManager._state.roots?.[0].path).to.equal(cwd)
    })

    it("falls back to fromLegacyCwd in single-root mode when no saved state", async () => {
        const stateManager = makeStateManager({
            multiRootEnabled: false,
            savedRoots: undefined,
        })
        const detectRoots = vi.fn().mockResolvedValue(defaultRoots) // not used

        const manager = await setupWorkspaceManager({
            stateManager: stateManager as any,
            historyItem: { id: "h2", ulid: "u2" } as any,
            detectRoots,
        })

        expect(detectRoots.mock.calls.length > 0).to.equal(false)
        expect(manager.getRoots()).to.have.length(1)
        expect(manager.getRoots()[0].path).to.equal(cwd)
        // persisted
        expect(stateManager._state.roots?.[0].path).to.equal(cwd)
        // telemetry called (skipped assertion in unit tests)
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls.length === 1).to.equal(true)
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls[0][0]).to.equal(1)
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls[0][1]).to.deep.equal(["none"])
        expect(fakeTelemetry.captureWorkspaceInitialized.mock.calls[0][3]).to.equal(false)
    })

    it("gracefully handles errors and falls back to fromLegacyCwd while warning user", async () => {
        // Multi-root enabled but detectRoots throws
        const stateManager = makeStateManager({ multiRootEnabled: true })
        const detectRoots = vi.fn().mockRejectedValue(new Error("boom"))

        // Multi-root workspace is now always enabled, no feature flag stub needed

        const manager = await setupWorkspaceManager({
            stateManager: stateManager as any,
            historyItem: undefined,
            detectRoots,
        })

        // fell back to single-root manager from legacy cwd
        expect(manager.getRoots()).to.have.length(1)
        expect(manager.getRoots()[0].path).to.equal(cwd)

        expect(fakeTelemetry.captureWorkspaceInitError.mock.calls.length === 1).to.equal(true)
        expect(fakeTelemetry.captureWorkspaceInitError.mock.calls[0][0]).to.be.instanceOf(Error)
        expect(fakeTelemetry.captureWorkspaceInitError.mock.calls[0][1]).to.equal(true)
        expect(fakeTelemetry.captureWorkspaceInitError.mock.calls[0][2]).to.equal(2)

        // persisted fallback state
        expect(stateManager._state.roots?.[0].path).to.equal(cwd)

        // message shown to user
        const showMessageSpy = HostProvider.window.showMessage as any /* sinon.SinonStub → vitest */
        expect(showMessageSpy.mock.calls.length === 1).to.equal(true)
        const msg = showMessageSpy.mock.calls[0][0]
        expect(msg?.message || "").to.match(/Failed to initialize workspace/i)
    })
})
