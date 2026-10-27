import type { EventEmitter } from "node:events"
import { afterAll, vi } from "vitest"
import { installIsolatedTestDirectories } from "./isolated-test-directories"

const cleanupIsolatedTestDirectories = installIsolatedTestDirectories(`backend-${process.pid}`)

const processListenerEvents = ["exit", "uncaughtException"] as const
const processEventEmitter = process as unknown as EventEmitter
const baselineProcessListeners = new Map(
    processListenerEvents.map((event) => [event, new Set(processEventEmitter.listeners(event))] as const),
)

afterAll(() => {
    for (const event of processListenerEvents) {
        const baseline = baselineProcessListeners.get(event)
        for (const listener of processEventEmitter.listeners(event)) {
            if (!baseline?.has(listener)) {
                processEventEmitter.removeListener(event, listener as (...args: unknown[]) => void)
            }
        }
    }
    cleanupIsolatedTestDirectories()
})

// sinon sandbox removed — use vi.mock / vi.spyOn / vi.fn() directly
;(() => {})()
// (sandbox polyfill removed)

// (sandbox polyfill removed)
void function _unused() {
    const stubs: Array<{ obj: any; method: string; original: any }> = []
    const _sandbox = {
        stub(obj: any, method: string) {
            const original = obj[method]
            stubs.push({ obj, method, original })
            const spy = vi.spyOn(obj, method as any)
            return {
                returns(val: any) {
                    spy.mockReturnValue(val)
                    return { returns: () => ({ returns: () => {} }) }
                },
                resolves(val: any) {
                    spy.mockResolvedValue(val)
                    return { returns: () => ({ returns: () => {} }) }
                },
                rejects(val: any) {
                    spy.mockRejectedValue(val)
                    return { returns: () => ({ returns: () => {} }) }
                },
            }
        },
        mockRestore() {
            for (const s of stubs) {
                s.obj[s.method] = s.original
            }
            stubs.length = 0
        },
    }
    // return sandbox (removed)
}

// Mock the 'vscode' module globally for all tests.
// This replaces the old Module.prototype.require hack from requires.ts.
vi.mock("vscode", async () => {
    const mock = await vi.importActual<typeof import("./vscode-mock")>("./vscode-mock.ts")
    return mock
})

// Mock HostProvider
vi.mock("@/hosts/host-provider", () => {
    const mockEnv = {
        getHostVersion: async () => ({ platform: "test", version: "0.0.0", remoteName: null }),
        clipboardReadText: async () => ({ value: "" }),
        clipboardWriteText: async (_req: any) => {},
    }
    const mockWindow = {
        showMessage: vi.fn(),
        getActiveEditor: async () => ({ filePath: "/test/mock/path" }),
        getOpenTabs: async () => [],
        getVisibleTabs: async () => [],
        showErrorMessage: () => {},
        showWarningMessage: () => {},
        showInformationMessage: () => {},
    }
    const mockWorkspace = {
        getWorkspacePaths: async () => ["/test/mock/path"],
        searchWorkspaceItems: async () => ({ items: [], totalCount: 0 }),
    }

    // Use a simple object with direct properties (no getters needed)
    // since vitest replaces the import binding directly
    const mockHostProvider = {
        get: () => mockHostProvider,
        reset: () => {},
        initialize: (..._args: any[]) => {},
        isInitialized: () => true,
        instance: {
            env: mockEnv,
            window: mockWindow,
            workspace: mockWorkspace,
            createTerminalManager: () => ({}),
            createDiffViewProvider: () => ({}),
            extensionFsPath: process.cwd(),
            globalStorageFsPath: process.cwd(),
            getBinaryLocation: async (name: string) => `/mock/path/to/binary/${name}`,
        },
        window: mockWindow,
        env: mockEnv,
        workspace: mockWorkspace,
        diff: { openMultiFileDiff: vi.fn(), closeAllDiffs: vi.fn().mockResolvedValue({}) },
        extensionFsPath: process.cwd(),
        globalStorageFsPath: process.cwd(),
        getBinaryLocation: async (name: string) => `/mock/path/to/binary/${name}`,
    }

    return { HostProvider: mockHostProvider }
})

// Mock HostRegistryInfo so StateManager.initialize() doesn't call HostProvider
vi.mock("@/registry", () => ({
    HostRegistryInfo: {
        init: async () => {},
        get: () => ({ platform: "test", version: "0.0.0", remoteName: null }),
    },
    ExtensionRegistryInfo: { version: "0.0.0-test" },
}))

// Mock checkpoint integration — avoids pulling in VSCode-specific code
vi.mock("@integrations/checkpoints", () => ({}))

// Mock telemetryService — avoid importing the real module which triggers config loading
vi.mock("@services/telemetry", () => {
    const fn = () => vi.fn()
    return {
        telemetryService: new Proxy({} as any, {
            get(_target, prop) {
                if (typeof prop === "string" && prop !== "then") {
                    if (!(prop in _target)) (_target as any)[prop] = vi.fn()
                    return (_target as any)[prop]
                }
                return undefined
            },
        }),
        getTelemetryService: async () => ({}),
        resetTelemetryService: () => {},
        TelemetryProviderFactory: { createProviders: fn },
        TerminalOutputFailureReason: {},
        TerminalUserInterventionAction: {},
        TerminalHangStage: {},
    }
})

// Required for String.prototype.toPosix
import "../utils/path"
