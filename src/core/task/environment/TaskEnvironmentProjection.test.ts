import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PromptProfile } from "@core/prompts/profiles/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaskEnvironmentProjection } from "./TaskEnvironmentProjection"

interface ProjectionOverrides {
    readonly cwd?: string
    readonly manager?: unknown
}

function projection(overrides: ProjectionOverrides = {}) {
    const beginRequest = vi.fn()
    const project = vi.fn(() => "# TODO LIST NEEDED\nCreate a TODO list now.")
    const stateManager = {
        getGlobalStateKey: vi.fn(() => false),
        getGlobalSettingsKey: vi.fn((key: string) => {
            if (key === "focusChainSettings") return { enabled: true, remindClineInterval: 1 }
            if (key === "showActiveTasksInEnvDetails") return false
            return false
        }),
    }
    const api = {
        getModel: () => ({ id: "test-model", info: { capabilities: { contextWindow: 128_000 } } }),
    }
    const value = new TaskEnvironmentProjection({
        identity: { taskId: "task-1", cwd: overrides.cwd ?? "C:/workspace" },
        host: {
            getHostVersion: vi.fn(async () => ({ platform: "test", clineVersion: "test" })),
            getVisibleFiles: vi.fn(async () => []),
            getOpenTabs: vi.fn(async () => []),
            buildActiveTasksSection: vi.fn(() => ""),
        } as never,
        workspace: {
            stateManager: stateManager as never,
            manager: overrides.manager as never,
            ignoreController: { filterPaths: vi.fn(() => []), validateAccess: vi.fn(() => true) } as never,
        },
        runtime: { getApi: () => api as never, getMode: () => "act", getPhase: () => "running" },
        conversation: {
            messages: { clineMessages: [] } as never,
            taskState: { didEditFile: false, currentFocusChainChecklist: null, currentInProgressItemIndex: 0 },
            focusChain: { beginRequest, project },
        },
        execution: {
            terminals: { getTerminals: vi.fn(() => []) } as never,
            tools: { getSubagentJobManager: () => ({ listJobs: () => [] }) } as never,
            commands: { listBackgroundCommands: () => [], markBackgroundCommandOutputSent: vi.fn() } as never,
        },
        tracking: {
            files: { peekRecentlyModifiedFiles: () => ({ files: [] }) } as never,
            taskFiles: { getAllModifiedFiles: () => [] } as never,
        },
    })
    return { value, beginRequest, project }
}

describe("TaskEnvironmentProjection Focus Chain reminders", () => {
    it("injects reminders only into real ordinary requests, not preview projections", async () => {
        const { value, beginRequest, project } = projection()

        const requestEnvironment = await value.build(false, PromptProfile.Standard)
        expect(requestEnvironment).toContain("# TODO LIST NEEDED")
        expect(beginRequest).toHaveBeenCalledTimes(1)
        expect(project).toHaveBeenCalledWith({ mode: "act" })

        const previewEnvironment = await value.build(false, PromptProfile.Standard, { preview: true })
        expect(previewEnvironment).not.toContain("# TODO LIST NEEDED")
        expect(beginRequest).toHaveBeenCalledTimes(1)
        expect(project).toHaveBeenCalledTimes(1)
    })
})

/** Splits `<environment_details>` into its `# Title` sections. */
function environmentSections(environment: string): Map<string, string> {
    const body = environment.replace(/^<environment_details>\n/, "").replace(/\n<\/environment_details>$/, "")
    const sections = new Map<string, string>()
    for (const block of body.split(/\n\n(?=# )/)) {
        const newline = block.indexOf("\n")
        const title = (newline === -1 ? block : block.slice(0, newline)).replace(/^# /, "")
        sections.set(title, newline === -1 ? "" : block.slice(newline + 1))
    }
    return sections
}

describe("TaskEnvironmentProjection workspace configuration", () => {
    const tempDirs: string[] = []

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    function workspaceDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dline-env-projection-"))
        tempDirs.push(dir)
        fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n")
        return dir
    }

    function manager(buildWorkspacesJson: () => Promise<string | null>) {
        return { getRoots: () => [], getPrimaryRoot: () => undefined, buildWorkspacesJson: vi.fn(buildWorkspacesJson) }
    }

    it("projects the workspace roots and their VCS identity into file-detail requests only", async () => {
        const workspaces = {
            workspaces: {
                [workspaceDir()]: { hint: "dline", associatedRemoteUrls: ["origin: https://example.test/dline.git"] },
            },
        }
        const workspaceManager = manager(async () => JSON.stringify(workspaces, null, 2))
        const { value } = projection({ cwd: workspaceDir(), manager: workspaceManager })

        const withDetails = environmentSections(await value.build(true, PromptProfile.Standard))
        expect(JSON.parse(withDetails.get("Workspace Configuration") ?? "null")).toEqual(workspaces)

        const withoutDetails = environmentSections(await value.build(false, PromptProfile.Standard))
        expect(withoutDetails.has("Workspace Configuration")).toBe(false)
        expect(workspaceManager.buildWorkspacesJson).toHaveBeenCalledTimes(1)
    })

    it("omits the section and still builds the request when the VCS probe fails", async () => {
        const workspaceManager = manager(async () => {
            throw new Error("git unavailable")
        })
        const { value } = projection({ cwd: workspaceDir(), manager: workspaceManager })

        const sections = environmentSections(await value.build(true, PromptProfile.Standard))
        expect(sections.has("Workspace Configuration")).toBe(false)
        expect(sections.get("Current Mode")).toBe("ACT MODE")
        expect(workspaceManager.buildWorkspacesJson).toHaveBeenCalledTimes(1)
    })
})
