import { beforeEach, describe, expect, it, vi } from "vitest"
import { MultiInstanceLauncher } from "./e2e/utils/multi-instance"

const mocks = vi.hoisted(() => ({
    apps: new Set<object>(),
    roots: new Set<string>(),
    launch: vi.fn(),
    signin: vi.fn(),
    firstWindow: vi.fn(),
}))

vi.mock("playwright", () => ({ _electron: { launch: mocks.launch } }))
vi.mock("@vscode/test-electron", () => ({
    downloadAndUnzipVSCode: async () => "/unit/vscode",
    SilentReporter: class {},
}))
vi.mock("./e2e/utils/vscode-version-resolver", () => ({
    E2E_VSCODE_DOWNLOAD_TIMEOUT_MS: 10_000,
    resolveVSCodeDownloadPlatform: () => "unit",
    resolveVSCodeDownloadVersion: () => "unit",
}))
vi.mock("./e2e/utils/vscode-launch-isolation", () => ({
    createLaunchIsolation: () => {
        const portableRoot = `/unit/portable-${mocks.roots.size}`
        mocks.roots.add(portableRoot)
        return { portableRoot, userDataDir: `${portableRoot}/data` }
    },
    createVSCodeExtensionLaunchArguments: () => [],
    FULL_RATE_RENDERING_ARGUMENTS: [],
    portableEnvironment: () => ({}),
}))
vi.mock("./e2e/utils/helpers", () => ({
    E2ETestHelper: class {
        static CODEBASE_ROOT_DIR = "/unit/repository"
        static waitUntil = async () => undefined
        static openClineSidebar = async () => undefined
        static dismissWhatsNewModal = async () => undefined
        static generateTestFileName = () => "unit"
        static rmForRetries = async (root: string) => mocks.roots.delete(root)
        getSidebar = async () => ({})
        signin = mocks.signin
    },
}))

function createLauncher() {
    return new MultiInstanceLauncher({
        dlineDir: "/unit/state",
        dlineDocsDir: "/unit/docs",
        extensionsDir: "/unit/extensions",
        workspaceDir: "/unit/workspace",
        server: { baseUrl: "http://127.0.0.1:1" },
        testInfo: { title: "unit", project: { name: "unit" }, status: "passed", expectedStatus: "passed" },
    } as ConstructorParameters<typeof MultiInstanceLauncher>[0])
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.apps.clear()
    mocks.roots.clear()
    mocks.signin.mockResolvedValue(undefined)
    mocks.firstWindow.mockResolvedValue({})
    mocks.launch.mockImplementation(async () => {
        const app = {
            windows: () => [{}],
            firstWindow: mocks.firstWindow,
            close: async () => mocks.apps.delete(app),
        }
        mocks.apps.add(app)
        return app
    })
})

describe("multi-instance launch cleanup", () => {
    it.each(["signin", "firstWindow"] as const)("releases a launched process when %s fails", async (phase) => {
        const failure = new Error(`${phase} failed`)
        mocks[phase].mockRejectedValue(failure)
        const launcher = createLauncher()
        await expect(launcher.launch("failed")).rejects.toBe(failure)
        expect(mocks.apps.size).toBe(1)
        await launcher.dispose()
        expect(mocks.apps.size).toBe(0)
        expect(mocks.roots.size).toBe(0)
    })

    it("releases successful instances and can be disposed again", async () => {
        const launcher = createLauncher()
        await launcher.launch("first")
        await launcher.launch("second")
        expect(mocks.apps.size).toBe(2)
        await launcher.dispose()
        await launcher.dispose()
        expect(mocks.apps.size).toBe(0)
        expect(mocks.roots.size).toBe(0)
    })
})
