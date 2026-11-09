import { Empty } from "@shared/proto/dline/common"
import {
    AvailableToolsResponse,
    RefreshedSubagents,
    SubagentCapabilitiesResponse,
    SubagentInfo,
    SubagentToggles,
    UpdateSubagentConfigRequest,
} from "@shared/proto/dline/file"
import { ApiProfile } from "@shared/proto/dline/profile"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { FileServiceClient } from "../../services/grpc-client"
import SubagentRow from "./SubagentRow"

vi.mock("../../services/grpc-client", () => ({
    FileServiceClient: {
        deleteSubagentFile: vi.fn(),
        getApiProfiles: vi.fn(),
        getAvailableTools: vi.fn(),
        getSubagentCapabilities: vi.fn(),
        openFile: vi.fn(),
        refreshSubagents: vi.fn(),
        updateSubagentConfig: vi.fn(),
    },
}))

let agentNumber = 0
const stored = new Map<string, SubagentInfo>()
const makeAgent = (overrides: Partial<SubagentInfo> = {}) =>
    SubagentInfo.create({
        name: "reviewer",
        description: "Reviews code",
        path: `C:\\workspace\\.agents\\subagents\\reviewer-${++agentNumber}.yml`,
        enabled: true,
        tools: ["read_file", "load_skill", "load_workflow", "load_mcp", "use_mcp_tool", "access_mcp_resource"],
        profile: "profile-a",
        ...overrides,
    })

interface ClearCase {
    label: string
    field: "rules" | "skills" | "workflows" | "mcp"
    name: string
    initial: Partial<SubagentInfo>
    patch: Partial<UpdateSubagentConfigRequest>
}
const CLEAR_CASES: ClearCase[] = [
    {
        label: "Rules",
        field: "rules",
        name: "Use rule workspace/guide.md",
        initial: { rules: [{ scope: "workspace", path: "guide.md" }] },
        patch: { rules: [], replaceRules: true },
    },
    {
        label: "Skills",
        field: "skills",
        name: "Use skill use-vitest",
        initial: { skills: ["use-vitest"] },
        patch: { skills: [], replaceSkills: true },
    },
    {
        label: "Workflows",
        field: "workflows",
        name: "Use workflow e2e-validation",
        initial: { workflows: ["e2e-validation"] },
        patch: { workflows: [], replaceWorkflows: true },
    },
    {
        label: "MCP",
        field: "mcp",
        name: "Use MCP tool owner/github/search_issues",
        initial: { mcp: [{ server: "owner/github", tools: ["search_issues"], resources: [] }] },
        patch: { mcp: [], replaceMcp: true },
    },
]

const directory = () =>
    SubagentCapabilitiesResponse.create({
        rules: [
            { name: "guide.md", description: "Workspace review policy", scope: "workspace", path: "guide.md", available: true },
            { name: "guide.md", description: "Global review policy", scope: "global", path: "guide.md", available: true },
            {
                name: "company-policy",
                description: "Enterprise policy",
                scope: "remote",
                path: "company-policy",
                required: true,
                available: true,
            },
        ],
        skills: [
            {
                name: "use-vitest",
                description: "Focused component tests",
                scope: "workspace",
                path: "use-vitest/SKILL.md",
                available: true,
            },
            {
                name: "review-checklist",
                description: "Review checklist",
                scope: "global",
                path: "review-checklist/SKILL.md",
                available: true,
            },
            { name: "company-skill", scope: "remote", path: "company-skill", required: true, available: true },
        ],
        workflows: [
            {
                name: "e2e-validation",
                description: "Run bounded end-to-end checks",
                scope: "workspace",
                path: "e2e.md",
                available: true,
            },
            { name: "company-workflow", scope: "remote", path: "company-workflow", required: true, available: true },
        ],
        mcp: [
            {
                name: "owner/github",
                displayName: "GitHub",
                available: true,
                tools: [{ name: "search_issues", description: "Search issues" }],
                resources: [
                    { uri: "repository://Instructions", name: "Instructions", description: "Repository guide" },
                    { uri: "repository://instructions", name: "Lowercase instructions", description: "Different exact URI" },
                ],
            },
            {
                name: "other/github",
                displayName: "GitHub",
                available: true,
                tools: [{ name: "search_issues", description: "Different owner" }],
            },
        ],
    })

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

/** Stateful RPC boundary: exercise real UI patch intent, then reopen from writes. */
async function persist(request: UpdateSubagentConfigRequest) {
    const current = stored.get(request.subagentPath)
    if (!current) throw new Error("Unknown subagent path")
    stored.set(
        request.subagentPath,
        SubagentInfo.create({
            ...current,
            ...(request.replaceTools ? { tools: request.tools } : {}),
            ...(request.replaceRules ? { rules: request.rules } : {}),
            ...(request.replaceSkills ? { skills: request.skills } : {}),
            ...(request.replaceWorkflows ? { workflows: request.workflows } : {}),
            ...(request.replaceMcp ? { mcp: request.mcp } : {}),
            ...(request.profile !== undefined ? { profile: request.profile || undefined } : {}),
        }),
    )
    return Empty.create({})
}

function mount(
    agent = makeAgent(),
    callbacks: { onToggle?: (path: string, enabled: boolean) => Promise<void> | void; onDelete?: () => void } = {},
) {
    if (!stored.has(agent.path)) stored.set(agent.path, agent)
    const props = { agent, isGlobal: false, onDelete: callbacks.onDelete ?? vi.fn(), onToggle: callbacks.onToggle ?? vi.fn() }
    return { ...render(<SubagentRow {...props} />), props }
}
async function expand() {
    fireEvent.click(screen.getByRole("button", { name: /Configure subagent/ }))
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Use read_file" })).toBeEnabled())
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toBeEnabled())
}
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name} \\(`) }))
const checkbox = (name: string) => screen.getByRole("checkbox", { name })
const saveStatus = () => screen.getByRole("status", { name: "Subagent configuration save status" })
const saved = () => waitFor(() => expect(saveStatus()).toHaveTextContent("Subagent configuration saved."))
function expectPatch(index: number, agent: SubagentInfo, patch: Partial<UpdateSubagentConfigRequest>) {
    expect(FileServiceClient.updateSubagentConfig).toHaveBeenNthCalledWith(
        index,
        UpdateSubagentConfigRequest.create({
            subagentPath: agent.path,
            ...patch,
        }),
    )
}

beforeEach(() => {
    stored.clear()
    vi.mocked(FileServiceClient.getAvailableTools)
        .mockReset()
        .mockResolvedValue(
            AvailableToolsResponse.create({
                groups: [
                    {
                        name: "Read & explore",
                        tools: [
                            { name: "read_file", description: "Read files", isReadOnly: true },
                            { name: "search_files", description: "Search files", isReadOnly: true },
                            { name: "attempt_completion", description: "Finish the subagent", isReadOnly: true, required: true },
                        ],
                    },
                    {
                        name: "Load instructions & MCP",
                        tools: ["load_skill", "load_workflow", "load_mcp", "use_mcp_tool", "access_mcp_resource"].map((name) => ({
                            name,
                            isReadOnly: true,
                        })),
                    },
                ],
            }),
        )
    vi.mocked(FileServiceClient.getApiProfiles)
        .mockReset()
        .mockResolvedValue({
            profiles: [
                ApiProfile.create({ id: "a", name: "profile-a", enabled: true, usedFor: ["subagents"] }),
                ApiProfile.create({ id: "b", name: "profile-b", enabled: true, usedFor: ["subagents"] }),
                ApiProfile.create({ id: "disabled", name: "disabled", enabled: false, usedFor: ["subagents"] }),
                ApiProfile.create({ id: "parent", name: "parent-only", enabled: true, usedFor: ["act"] }),
            ],
        })
    vi.mocked(FileServiceClient.getSubagentCapabilities).mockReset().mockResolvedValue(directory())
    vi.mocked(FileServiceClient.updateSubagentConfig).mockReset().mockImplementation(persist)
    vi.mocked(FileServiceClient.refreshSubagents)
        .mockReset()
        .mockImplementation(async () => ({
            globalSubagents: [],
            localSubagents: [...stored.values()],
        }))
    vi.mocked(FileServiceClient.openFile).mockReset().mockResolvedValue(Empty.create({}))
    vi.mocked(FileServiceClient.deleteSubagentFile).mockReset().mockResolvedValue(SubagentToggles.create({}))
})
afterEach(cleanup)

describe("SubagentRow independent capability editor", () => {
    it("reads on expansion only and searches all five keyboard tabs without mutating hidden choices", async () => {
        const agent = makeAgent({ skills: ["use-vitest"] })
        mount(agent)
        expect(FileServiceClient.getAvailableTools).not.toHaveBeenCalled()
        expect(FileServiceClient.getSubagentCapabilities).not.toHaveBeenCalled()
        expect(screen.getByRole("button", { name: /Configure subagent/ })).toHaveAttribute("aria-expanded", "false")
        await expand()
        expect(FileServiceClient.getSubagentCapabilities).toHaveBeenCalledTimes(1)
        expect(FileServiceClient.getSubagentCapabilities).toHaveBeenCalledWith({ subagentPath: agent.path })
        expect(screen.getAllByRole("tab")).toHaveLength(5)
        expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("profile-a")
        expect(screen.queryByRole("option", { name: "disabled" })).not.toBeInTheDocument()
        expect(screen.queryByRole("option", { name: "parent-only" })).not.toBeInTheDocument()
        tab("Skills")
        expect(await screen.findByRole("checkbox", { name: "Use skill use-vitest" })).toBeChecked()
        fireEvent.change(screen.getByRole("searchbox", { name: "Search Skills" }), { target: { value: "global" } })
        expect(screen.queryByRole("checkbox", { name: "Use skill use-vitest" })).not.toBeInTheDocument()
        expect(checkbox("Use skill review-checklist")).toBeInTheDocument()
        fireEvent.change(screen.getByRole("searchbox", { name: "Search Skills" }), { target: { value: "no-such-capability" } })
        expect(screen.getByText("No matching capabilities.")).toBeInTheDocument()
        expect(screen.getByLabelText("Active skills")).toHaveTextContent("1")
        fireEvent.change(screen.getByRole("searchbox", { name: "Search Skills" }), { target: { value: "" } })
        expect(checkbox("Use skill use-vitest")).toBeChecked()
        fireEvent.keyDown(screen.getByRole("tab", { name: /^Skills / }), { key: "ArrowRight" })
        expect(screen.getByRole("tab", { name: /^Workflows / })).toHaveFocus()
        expect(screen.getByRole("tab", { name: /^Workflows / })).toHaveAttribute("aria-selected", "true")
        fireEvent.keyDown(screen.getByRole("tab", { name: /^Workflows / }), { key: "Home" })
        expect(screen.getByRole("tab", { name: /^Tools / })).toHaveFocus()
        tab("Rules")
        tab("MCP")
        expect(FileServiceClient.getSubagentCapabilities).toHaveBeenCalledTimes(1)
        expect(FileServiceClient.getAvailableTools).toHaveBeenCalledTimes(1)
        expect(FileServiceClient.updateSubagentConfig).not.toHaveBeenCalled()
        expect(screen.queryByRole("textbox", { name: /system/i })).not.toBeInTheDocument()
    })

    it("renders required tools separately, strips them from tool patches and retains missing tool selections", async () => {
        const agent = makeAgent({ tools: ["read_file", "attempt_completion", "removed_tool"] })
        mount(agent)
        await expand()
        const required = within(screen.getByRole("region", { name: "Required Tools" })).getByRole("checkbox", {
            name: "Use attempt_completion",
        })
        expect(required).toBeChecked()
        expect(required).toBeDisabled()
        expect(checkbox("Use removed_tool")).toBeChecked()
        expect(checkbox("Use removed_tool")).toBeDisabled()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        expectPatch(1, agent, { tools: ["read_file", "removed_tool", "search_files"], replaceTools: true })
        expect(required).toBeChecked()
        fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "profile-b" } })
        await saved()
        expectPatch(2, agent, { profile: "profile-b" })
    })

    it("matches Rules by scope/path without a loader and does not persist required enterprise Rules", async () => {
        const agent = makeAgent({
            tools: ["read_file"],
            rules: [
                { scope: "global", path: "guide.md" },
                { scope: "remote", path: "company-policy" },
            ],
        })
        mount(agent)
        await expand()
        tab("Rules")
        const workspace = await screen.findByRole("checkbox", { name: "Use rule workspace/guide.md" })
        expect(workspace).toBeEnabled()
        expect(checkbox("Use rule global/guide.md")).toBeChecked()
        const required = within(screen.getByRole("region", { name: "Required Rules" })).getByRole("checkbox", {
            name: "Use rule remote/company-policy",
        })
        expect(required).toBeChecked()
        expect(required).toBeDisabled()
        expect(screen.queryByText("Missing prerequisite tools")).not.toBeInTheDocument()
        fireEvent.click(workspace)
        await saved()
        expectPatch(1, agent, {
            rules: [
                { scope: "global", path: "guide.md" },
                { scope: "workspace", path: "guide.md" },
            ],
            replaceRules: true,
        })
        expect(screen.getByLabelText("Active rules")).toHaveTextContent("2")
    })

    it("allows Rules without a readable tool directory because Rules have no loader prerequisite", async () => {
        vi.mocked(FileServiceClient.getAvailableTools).mockRejectedValueOnce(new Error("Tool directory failed"))
        const agent = makeAgent({ tools: [] })
        mount(agent)
        fireEvent.click(screen.getByRole("button", { name: /Configure subagent/ }))
        tab("Rules")
        const rule = await screen.findByRole("checkbox", { name: "Use rule workspace/guide.md" })
        await waitFor(() => expect(rule).toBeEnabled())
        fireEvent.click(rule)
        await saved()
        expectPatch(1, agent, { rules: [{ scope: "workspace", path: "guide.md" }], replaceRules: true })
    })

    it("retains skill/workflow choices through loader disable, reopen and re-enable", async () => {
        const agent = makeAgent({ tools: ["read_file"], skills: ["use-vitest"], workflows: ["e2e-validation"] })
        mount(agent)
        await expand()
        tab("Skills")
        expect(await screen.findByRole("checkbox", { name: "Use skill use-vitest" })).toBeChecked()
        expect(checkbox("Use skill use-vitest")).toBeDisabled()
        expect(screen.getByLabelText("Active skills")).toHaveTextContent("0")
        expect(FileServiceClient.updateSubagentConfig).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole("button", { name: "Enable load_skill" }))
        await saved()
        expectPatch(1, agent, { tools: ["read_file", "load_skill"], replaceTools: true })
        expect(checkbox("Use skill use-vitest")).toBeEnabled()
        expect(screen.getByLabelText("Active skills")).toHaveTextContent("1")
        tab("Workflows")
        expect(checkbox("Use workflow e2e-validation")).toBeChecked()
        expect(checkbox("Use workflow e2e-validation")).toBeDisabled()
        fireEvent.click(screen.getByRole("button", { name: "Enable load_workflow" }))
        await saved()
        expect(screen.getByLabelText("Active workflows")).toHaveTextContent("1")
        tab("Tools")
        fireEvent.click(checkbox("Use load_skill"))
        await saved()
        expectPatch(3, agent, { tools: ["read_file", "load_workflow"], replaceTools: true })
        tab("Skills")
        expect(checkbox("Use skill use-vitest")).toBeChecked()
        expect(checkbox("Use skill use-vitest")).toBeDisabled()
        expect(stored.get(agent.path)?.skills).toEqual(["use-vitest"])
        expect(stored.get(agent.path)?.workflows).toEqual(["e2e-validation"])
        fireEvent.click(screen.getByRole("button", { name: /Configure subagent/ }))
        fireEvent.click(screen.getByRole("button", { name: /Configure subagent/ }))
        await waitFor(() => expect(screen.queryByText("Loading available skills...")).not.toBeInTheDocument())
        expect(checkbox("Use skill use-vitest")).toBeChecked()
        expect(checkbox("Use skill use-vitest")).toBeDisabled()
        fireEvent.click(screen.getByRole("button", { name: "Enable load_skill" }))
        await saved()
        expect(screen.getByLabelText("Active skills")).toHaveTextContent("1")
    })

    it.each(["skills", "workflows"] as const)("does not persist required %s as an ordinary selection", async (kind) => {
        const required = kind === "skills" ? "company-skill" : "company-workflow"
        const optional = kind === "skills" ? "review-checklist" : "e2e-validation"
        const singular = kind === "skills" ? "skill" : "workflow"
        const agent = makeAgent({ [kind]: [required] })
        mount(agent)
        await expand()
        tab(kind === "skills" ? "Skills" : "Workflows")
        expect(await screen.findByRole("checkbox", { name: `Use ${singular} ${required}` })).toBeDisabled()
        fireEvent.click(checkbox(`Use ${singular} ${optional}`))
        await saved()
        expectPatch(
            1,
            agent,
            kind === "skills" ? { skills: [optional], replaceSkills: true } : { workflows: [optional], replaceWorkflows: true },
        )
    })

    it("uses exact MCP server/tool/URI identities and independent resource versus tool gates", async () => {
        const agent = makeAgent({ tools: ["read_file", "access_mcp_resource"] })
        mount(agent)
        await expand()
        tab("MCP")
        expect(
            await screen.findByRole("checkbox", { name: "Use MCP resource owner/github/repository://Instructions" }),
        ).toBeEnabled()
        expect(checkbox("Use MCP tool owner/github/search_issues")).toBeDisabled()
        expect(checkbox("Use MCP tool other/github/search_issues")).toBeDisabled()
        fireEvent.click(checkbox("Use MCP resource owner/github/repository://Instructions"))
        await saved()
        expectPatch(1, agent, {
            mcp: [{ server: "owner/github", tools: [], resources: ["repository://Instructions"] }],
            replaceMcp: true,
        })
        fireEvent.click(checkbox("Use MCP resource owner/github/repository://instructions"))
        await saved()
        expectPatch(2, agent, {
            mcp: [{ server: "owner/github", tools: [], resources: ["repository://Instructions", "repository://instructions"] }],
            replaceMcp: true,
        })
        fireEvent.click(screen.getByRole("button", { name: "Enable load_mcp" }))
        await saved()
        expect(checkbox("Use MCP tool owner/github/search_issues")).toBeDisabled()
        fireEvent.click(screen.getByRole("button", { name: "Enable use_mcp_tool" }))
        await saved()
        fireEvent.click(checkbox("Use MCP tool owner/github/search_issues"))
        await saved()
        fireEvent.click(checkbox("Use MCP tool other/github/search_issues"))
        await saved()
        expectPatch(6, agent, {
            mcp: [
                {
                    server: "owner/github",
                    tools: ["search_issues"],
                    resources: ["repository://Instructions", "repository://instructions"],
                },
                { server: "other/github", tools: ["search_issues"], resources: [] },
            ],
            replaceMcp: true,
        })
        expect(screen.getByLabelText("Active MCP items")).toHaveTextContent("4")
        tab("Tools")
        fireEvent.click(checkbox("Use load_mcp"))
        await saved()
        expectPatch(7, agent, { tools: ["read_file", "access_mcp_resource", "use_mcp_tool"], replaceTools: true })
        tab("MCP")
        expect(checkbox("Use MCP tool owner/github/search_issues")).toBeChecked()
        expect(checkbox("Use MCP tool owner/github/search_issues")).toBeDisabled()
        expect(checkbox("Use MCP resource owner/github/repository://Instructions")).toBeChecked()
        expect(checkbox("Use MCP resource owner/github/repository://Instructions")).toBeEnabled()
        expect(screen.getByLabelText("Active MCP items")).toHaveTextContent("2")
        expect(stored.get(agent.path)?.mcp).toHaveLength(2)
    })

    it("preserves missing/disconnected selections across unrelated patches and supports explicit removal", async () => {
        const catalog = directory()
        catalog.skills.push({
            name: "offline-skill",
            description: "Removed on disk",
            scope: "global",
            path: "offline/SKILL.md",
            required: false,
            available: false,
            unavailableReason: "Cannot read skill",
        })
        catalog.mcp.push({
            name: "database",
            displayName: "Database",
            available: false,
            unavailableReason: "Server disconnected",
            tools: [{ name: "query", description: "Query data" }],
            resources: [],
        })
        vi.mocked(FileServiceClient.getSubagentCapabilities).mockResolvedValue(catalog)
        const agent = makeAgent({
            rules: [{ scope: "workspace", path: "deleted.md" }],
            skills: ["lost-skill", "offline-skill"],
            workflows: ["lost-workflow"],
            mcp: [
                { server: "database", tools: ["query"], resources: [] },
                { server: "gone", tools: ["query"], resources: ["uri://exact"] },
            ],
        })
        mount(agent)
        await expand()
        tab("Rules")
        expect(await screen.findByRole("checkbox", { name: "Use rule workspace/deleted.md" })).toBeChecked()
        expect(checkbox("Use rule workspace/deleted.md")).toBeDisabled()
        tab("Skills")
        expect(checkbox("Use skill lost-skill")).toBeChecked()
        expect(checkbox("Use skill lost-skill")).toBeDisabled()
        expect(checkbox("Use skill offline-skill")).toBeDisabled()
        expect(screen.getByText(/Cannot read skill/)).toBeInTheDocument()
        fireEvent.click(checkbox("Use skill review-checklist"))
        await saved()
        expectPatch(1, agent, { skills: ["lost-skill", "offline-skill", "review-checklist"], replaceSkills: true })
        tab("Workflows")
        expect(checkbox("Use workflow lost-workflow")).toBeChecked()
        tab("MCP")
        expect(checkbox("Use MCP tool database/query")).toBeChecked()
        expect(checkbox("Use MCP tool database/query")).toBeDisabled()
        expect(screen.getByText(/Server disconnected/)).toBeInTheDocument()
        expect(checkbox("Use MCP resource gone/uri://exact")).toBeChecked()
        expect(screen.getByLabelText("Active MCP items")).toHaveTextContent("0")
        expect(stored.get(agent.path)?.mcp).toEqual(agent.mcp)
        fireEvent.click(screen.getByRole("button", { name: "Remove unavailable selection: Use MCP tool gone/query" }))
        await saved()
        expectPatch(2, agent, {
            mcp: [
                { server: "database", tools: ["query"], resources: [] },
                { server: "gone", tools: [], resources: ["uri://exact"] },
            ],
            replaceMcp: true,
        })
        tab("Rules")
        fireEvent.click(screen.getByRole("button", { name: "Remove unavailable selection: Use rule workspace/deleted.md" }))
        await saved()
        expectPatch(3, agent, { rules: [], replaceRules: true })
    })

    it.each(CLEAR_CASES)("clears $label with empty replacement and reopens as unselected rather than inherited", async ({
        label,
        field,
        name,
        initial,
        patch,
    }) => {
        const agent = makeAgent(initial)
        const first = mount(agent)
        await expand()
        tab(label)
        expect(await screen.findByRole("checkbox", { name })).toBeChecked()
        fireEvent.click(checkbox(name))
        await saved()
        expectPatch(1, agent, patch)
        expect(stored.get(agent.path)?.[field]).toEqual([])
        first.unmount()
        const reloaded = stored.get(agent.path)
        if (!reloaded) throw new Error("No saved subagent")
        mount(reloaded)
        await expand()
        tab(label)
        expect(await screen.findByRole("checkbox", { name })).not.toBeChecked()
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
    })

    it("prunes empty MCP servers and eventually sends empty top-level replacement without dropping unrelated items", async () => {
        const agent = makeAgent({
            mcp: [
                { server: "owner/github", tools: ["search_issues"], resources: ["repository://Instructions"] },
                { server: "other/github", tools: ["search_issues"], resources: [] },
            ],
        })
        mount(agent)
        await expand()
        tab("MCP")
        fireEvent.click(await screen.findByRole("checkbox", { name: "Use MCP tool owner/github/search_issues" }))
        await saved()
        expectPatch(1, agent, {
            mcp: [
                { server: "other/github", tools: ["search_issues"], resources: [] },
                { server: "owner/github", tools: [], resources: ["repository://Instructions"] },
            ],
            replaceMcp: true,
        })
        fireEvent.click(checkbox("Use MCP resource owner/github/repository://Instructions"))
        await saved()
        expectPatch(2, agent, { mcp: [{ server: "other/github", tools: ["search_issues"], resources: [] }], replaceMcp: true })
        fireEvent.click(checkbox("Use MCP tool other/github/search_issues"))
        await saved()
        expectPatch(3, agent, { mcp: [], replaceMcp: true })
    })

    it("distinguishes empty directory and search miss without writing configuration", async () => {
        vi.mocked(FileServiceClient.getSubagentCapabilities).mockResolvedValue(SubagentCapabilitiesResponse.create({}))
        mount()
        await expand()
        tab("Skills")
        expect(await screen.findByText("No skills available.")).toBeInTheDocument()
        fireEvent.change(screen.getByRole("searchbox", { name: "Search Skills" }), { target: { value: "missing" } })
        expect(screen.getByText("No matching capabilities.")).toBeInTheDocument()
        expect(FileServiceClient.updateSubagentConfig).not.toHaveBeenCalled()
    })
})

describe("SubagentRow save and lifecycle boundaries", () => {
    it("serializes Tools, Profile and capabilities for one path without replacing neighboring fields", async () => {
        const first = deferred<Empty>()
        const second = deferred<Empty>()
        vi.mocked(FileServiceClient.updateSubagentConfig)
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise)
        const agent = makeAgent()
        mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "profile-b" } })
        tab("Skills")
        fireEvent.click(await screen.findByRole("checkbox", { name: "Use skill use-vitest" }))
        expect(saveStatus()).toHaveTextContent("Saving")
        expect(checkbox("Use skill use-vitest")).toBeChecked()
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
        expectPatch(1, agent, { tools: [...agent.tools, "search_files"], replaceTools: true })
        await act(async () => first.resolve(Empty.create({})))
        await waitFor(() => expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(2))
        expectPatch(2, agent, { profile: "profile-b" })
        expect(saveStatus()).toHaveTextContent("Saving")
        await act(async () => second.resolve(Empty.create({})))
        await saved()
        expectPatch(3, agent, { skills: ["use-vitest"], replaceSkills: true })
        expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("profile-b")
    })

    it("rolls back a failed intent and rebases the next same-category patch instead of persisting the failed choice", async () => {
        const first = deferred<Empty>()
        const second = deferred<Empty>()
        vi.mocked(FileServiceClient.updateSubagentConfig)
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise)
        const agent = makeAgent({ tools: ["read_file"] })
        mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        fireEvent.click(checkbox("Use load_skill"))
        expect(checkbox("Use search_files")).toBeChecked()
        expect(checkbox("Use load_skill")).toBeChecked()
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
        await act(async () => first.reject(new Error("Disk is read-only")))
        await waitFor(() => expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(2))
        expectPatch(2, agent, { tools: ["read_file", "load_skill"], replaceTools: true })
        expect(checkbox("Use search_files")).not.toBeChecked()
        expect(checkbox("Use load_skill")).toBeChecked()
        expect(screen.getByRole("alert")).toHaveTextContent("Failed change was rolled back")
        expect(saveStatus()).toHaveTextContent("Saving")
        await act(async () => second.resolve(Empty.create({})))
        await waitFor(() => expect(saveStatus()).toHaveTextContent("Some changes were not saved"))
        expect(checkbox("Use load_skill")).toBeChecked()
        expect(checkbox("Use search_files")).not.toBeChecked()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        expectPatch(3, agent, { tools: ["read_file", "load_skill", "search_files"], replaceTools: true })
    })

    it("rolls a failed Profile back without undoing successful Tools or later Rules intent", async () => {
        const profileWrite = deferred<Empty>()
        vi.mocked(FileServiceClient.updateSubagentConfig)
            .mockImplementationOnce(persist)
            .mockImplementationOnce(() => profileWrite.promise)
        const agent = makeAgent()
        mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "profile-b" } })
        tab("Rules")
        fireEvent.click(await screen.findByRole("checkbox", { name: "Use rule workspace/guide.md" }))
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(2)
        await act(async () => profileWrite.reject(new Error("Profile write failed")))
        await waitFor(() => expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(3))
        expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("profile-a")
        expect(checkbox("Use rule workspace/guide.md")).toBeChecked()
        tab("Tools")
        expect(checkbox("Use search_files")).toBeChecked()
        expectPatch(3, agent, { rules: [{ scope: "workspace", path: "guide.md" }], replaceRules: true })
    })

    it("ignores old save results/intermediate props while preserving newer intent and unrelated external changes", async () => {
        const first = deferred<Empty>()
        const second = deferred<Empty>()
        vi.mocked(FileServiceClient.updateSubagentConfig)
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise)
        const agent = makeAgent({ tools: ["read_file"] })
        const view = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        fireEvent.click(checkbox("Use search_files"))
        expect(checkbox("Use search_files")).not.toBeChecked()
        await act(async () => first.resolve(Empty.create({})))
        await waitFor(() => expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(2))
        expectPatch(2, agent, { tools: ["read_file"], replaceTools: true })
        expect(checkbox("Use search_files")).not.toBeChecked()
        view.rerender(
            <SubagentRow
                {...view.props}
                agent={SubagentInfo.create({ ...agent, tools: ["read_file", "search_files"], profile: "profile-b" })}
            />,
        )
        expect(checkbox("Use search_files")).not.toBeChecked()
        expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("profile-b")
        await act(async () => second.resolve(Empty.create({})))
        await saved()
        view.rerender(<SubagentRow {...view.props} agent={SubagentInfo.create({ ...agent, profile: "profile-b" })} />)
        expect(checkbox("Use search_files")).not.toBeChecked()
        view.rerender(
            <SubagentRow
                {...view.props}
                agent={SubagentInfo.create({
                    ...agent,
                    tools: ["read_file", "load_skill"],
                    skills: ["review-checklist"],
                    profile: "profile-b",
                })}
            />,
        )
        expect(checkbox("Use load_skill")).toBeChecked()
        tab("Skills")
        expect(checkbox("Use skill review-checklist")).toBeChecked()
    })

    it("verifies ambiguous old props after acknowledgement without losing a genuine external YAML revert", async () => {
        const agent = makeAgent({ tools: ["read_file"] })
        const view = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        const acknowledged = stored.get(agent.path)
        if (!acknowledged) throw new Error("No saved subagent")
        view.rerender(<SubagentRow {...view.props} agent={acknowledged} />)
        view.rerender(<SubagentRow {...view.props} agent={agent} />)
        expect(checkbox("Use search_files")).toBeChecked()
        await waitFor(() => expect(FileServiceClient.refreshSubagents).toHaveBeenCalledTimes(1))
        expect(checkbox("Use search_files")).toBeChecked()
        // The identical old value may also be an intentional edit in YAML.
        view.rerender(<SubagentRow {...view.props} agent={acknowledged} />)
        stored.set(agent.path, agent)
        view.rerender(<SubagentRow {...view.props} agent={agent} />)
        await waitFor(() => expect(checkbox("Use search_files")).not.toBeChecked())
        expect(FileServiceClient.refreshSubagents).toHaveBeenCalledTimes(2)
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
    })

    it("can reconcile an external revert which arrives before the first prop acknowledgement", async () => {
        const agent = makeAgent({ tools: ["read_file"] })
        const view = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        stored.set(agent.path, agent)
        view.rerender(<SubagentRow {...view.props} agent={SubagentInfo.create(agent)} />)
        await waitFor(() => expect(checkbox("Use search_files")).not.toBeChecked())
        expect(FileServiceClient.refreshSubagents).toHaveBeenCalledTimes(1)
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
    })

    it("does not let a stale verification read overwrite an edit started after that read", async () => {
        const staleRead = deferred<RefreshedSubagents>()
        const agent = makeAgent({ tools: ["read_file"] })
        const view = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        const acknowledged = stored.get(agent.path)
        if (!acknowledged) throw new Error("No saved subagent")
        view.rerender(<SubagentRow {...view.props} agent={acknowledged} />)
        vi.mocked(FileServiceClient.refreshSubagents).mockImplementationOnce(() => staleRead.promise)
        view.rerender(<SubagentRow {...view.props} agent={agent} />)
        await waitFor(() => expect(FileServiceClient.refreshSubagents).toHaveBeenCalledTimes(1))
        fireEvent.click(checkbox("Use load_skill"))
        await saved()
        await act(async () => staleRead.resolve(RefreshedSubagents.create({ localSubagents: [agent] })))
        expect(checkbox("Use search_files")).toBeChecked()
        expect(checkbox("Use load_skill")).toBeChecked()
        expectPatch(2, agent, { tools: ["read_file", "search_files", "load_skill"], replaceTools: true })
    })

    it("surfaces verification failures without rolling back successful saves and can retry the read", async () => {
        const agent = makeAgent({ tools: ["read_file"] })
        const view = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        const acknowledged = stored.get(agent.path)
        if (!acknowledged) throw new Error("No saved subagent")
        view.rerender(<SubagentRow {...view.props} agent={acknowledged} />)
        vi.mocked(FileServiceClient.refreshSubagents).mockRejectedValueOnce(new Error("Read offline"))
        view.rerender(<SubagentRow {...view.props} agent={agent} />)
        expect(await screen.findByRole("alert")).toHaveTextContent("Latest local choices were kept")
        expect(checkbox("Use search_files")).toBeChecked()
        fireEvent.click(screen.getByRole("button", { name: "Retry refreshed configuration" }))
        await saved()
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
    })

    it("keeps completed but not-yet-acknowledged saves when reopening with stale props", async () => {
        const agent = makeAgent({ tools: ["read_file"] })
        const initial = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        await saved()
        initial.unmount()
        mount(agent)
        await expand()
        expect(checkbox("Use search_files")).toBeChecked()
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
    })

    it("keeps save progress and failures visible when the row is collapsed", async () => {
        const write = deferred<Empty>()
        vi.mocked(FileServiceClient.updateSubagentConfig).mockImplementationOnce(() => write.promise)
        mount(makeAgent({ tools: ["read_file"] }))
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        fireEvent.click(screen.getByRole("button", { name: /Configure subagent/ }))
        expect(saveStatus()).toHaveTextContent("Saving")
        await act(async () => write.reject(new Error("Write denied")))
        expect(saveStatus()).toHaveTextContent("Some changes were not saved")
        expect(screen.getByRole("alert")).toHaveTextContent("Failed change was rolled back")
        await expand()
        expect(checkbox("Use search_files")).not.toBeChecked()
    })

    it("keeps accepted saves through unmount and reuses the same-path in-flight queue on reopen", async () => {
        const first = deferred<Empty>()
        vi.mocked(FileServiceClient.updateSubagentConfig).mockImplementationOnce(() => first.promise)
        const agent = makeAgent({ tools: ["read_file"] })
        const initial = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        initial.unmount()
        mount(agent)
        await expand()
        expect(checkbox("Use search_files")).toBeChecked()
        fireEvent.click(checkbox("Use load_skill"))
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1)
        await act(async () => first.resolve(Empty.create({})))
        await saved()
        expectPatch(2, agent, { tools: ["read_file", "search_files", "load_skill"], replaceTools: true })
        expect(checkbox("Use search_files")).toBeChecked()
        expect(checkbox("Use load_skill")).toBeChecked()
    })

    it("resets when the agent path changes, ignores old catalogs/saves and allows independent saves for another path", async () => {
        const oldWrite = deferred<Empty>()
        const oldCatalog = deferred<SubagentCapabilitiesResponse>()
        vi.mocked(FileServiceClient.updateSubagentConfig).mockImplementationOnce(() => oldWrite.promise)
        vi.mocked(FileServiceClient.getSubagentCapabilities).mockImplementationOnce(() => oldCatalog.promise)
        const agent = makeAgent({ tools: ["read_file"], skills: ["use-vitest"] })
        const view = mount(agent)
        await expand()
        fireEvent.click(checkbox("Use search_files"))
        const other = makeAgent({ name: "other-agent", tools: ["read_file"], profile: "profile-b" })
        stored.set(other.path, other)
        view.rerender(<SubagentRow {...view.props} agent={other} />)
        expect(screen.getByRole("button", { name: "Configure subagent other-agent" })).toHaveAttribute("aria-expanded", "false")
        await expand()
        expect(checkbox("Use search_files")).not.toBeChecked()
        expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("profile-b")
        fireEvent.click(checkbox("Use load_skill"))
        await saved()
        expectPatch(2, other, { tools: ["read_file", "load_skill"], replaceTools: true })
        tab("Skills")
        expect(await screen.findByRole("checkbox", { name: "Use skill use-vitest" })).not.toBeChecked()
        await act(async () => {
            oldCatalog.resolve(SubagentCapabilitiesResponse.create({ skills: [{ name: "old-only", available: true }] }))
            oldWrite.reject(new Error("Old agent save failed"))
        })
        expect(screen.queryByRole("checkbox", { name: "Use skill old-only" })).not.toBeInTheDocument()
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
        expect(checkbox("Use skill use-vitest")).not.toBeChecked()
        expect(FileServiceClient.getSubagentCapabilities).toHaveBeenLastCalledWith({ subagentPath: other.path })
    })

    it("shows directory failures, keeps saved selections, and retries using bounded reads", async () => {
        vi.mocked(FileServiceClient.getSubagentCapabilities).mockRejectedValueOnce(new Error("Catalog offline"))
        mount(makeAgent({ skills: ["use-vitest"] }))
        await expand()
        tab("Skills")
        expect(await screen.findByRole("alert")).toHaveTextContent("Catalog offline")
        expect(checkbox("Use skill use-vitest")).toBeChecked()
        expect(checkbox("Use skill use-vitest")).toBeDisabled()
        expect(FileServiceClient.updateSubagentConfig).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole("button", { name: "Retry capability directories" }))
        await waitFor(() => expect(checkbox("Use skill use-vitest")).toBeEnabled())
        expect(checkbox("Use skill use-vitest")).toBeChecked()
        expect(FileServiceClient.getSubagentCapabilities).toHaveBeenCalledTimes(2)
        expect(FileServiceClient.updateSubagentConfig).not.toHaveBeenCalled()
    })

    it("does not let an older failed enabled toggle clear a newer pending intent", async () => {
        const first = deferred<void>()
        const onToggle = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementation(() => Promise.resolve())
        mount(makeAgent(), { onToggle })
        const toggle = screen.getByRole("switch", { name: "Enable subagent reviewer" })
        fireEvent.click(toggle)
        fireEvent.click(toggle)
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute("data-state", "unchecked")
        expect(onToggle).toHaveBeenCalledTimes(3)
        await act(async () => first.reject(new Error("First toggle failed")))
        expect(toggle).toHaveAttribute("data-state", "unchecked")
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("preserves Edit/Delete and sends an explicit empty Profile with no list replacement", async () => {
        const agent = makeAgent()
        const onDelete = vi.fn()
        mount(agent, { onDelete })
        fireEvent.click(screen.getByRole("button", { name: "Edit subagent file" }))
        expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: agent.path }))
        await expand()
        fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "" } })
        await saved()
        expectPatch(1, agent, { profile: "" })
        fireEvent.click(screen.getByRole("button", { name: "Delete subagent file" }))
        await waitFor(() => expect(onDelete).toHaveBeenCalledOnce())
        expect(FileServiceClient.deleteSubagentFile).toHaveBeenCalledWith(
            expect.objectContaining({ subagentPath: agent.path, isGlobal: false }),
        )
    })
})

describe("SubagentRow live UI language", () => {
    it("switches both ways without remounting search, choices or directories and preserves exact scope and MCP URI patches", async () => {
        const agent = makeAgent({ rules: [{ scope: "global", path: "guide.md" }] })
        stored.set(agent.path, agent)
        const onToggle = vi.fn()
        const props = { agent, isGlobal: false, onToggle, onDelete: vi.fn() }
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <SubagentRow {...props} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await expand()
        tab("Rules")
        const search = screen.getByRole("searchbox", { name: "Search Rules" })
        fireEvent.change(search, { target: { value: "guide.md" } })
        const globalRule = checkbox("Use rule global/guide.md")
        const workspaceRule = checkbox("Use rule workspace/guide.md")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("searchbox", { name: "搜索规则" })).toBe(search)
        expect(search).toHaveValue("guide.md")
        expect(checkbox("使用规则 global/guide.md")).toBe(globalRule)
        expect(globalRule).toBeChecked()
        expect(checkbox("使用规则 workspace/guide.md")).toBe(workspaceRule)
        expect(screen.getByText("Workspace review policy")).toBeInTheDocument()
        expect(screen.getByText("Global review policy")).toBeInTheDocument()
        fireEvent.click(workspaceRule)
        await waitFor(() =>
            expect(screen.getByRole("status", { name: "子智能体配置保存状态" })).toHaveTextContent("子智能体配置已保存"),
        )
        expectPatch(1, agent, {
            rules: [
                { scope: "global", path: "guide.md" },
                { scope: "workspace", path: "guide.md" },
            ],
            replaceRules: true,
        })
        view.rerender(tree("en"))
        expect(checkbox("Use rule workspace/guide.md")).toBe(workspaceRule)
        expect(workspaceRule).toBeChecked()
        tab("MCP")
        const resource = checkbox("Use MCP resource owner/github/repository://Instructions")
        view.rerender(tree("zh-CN"))
        expect(checkbox("使用 MCP 资源 owner/github/repository://Instructions")).toBe(resource)
        expect(screen.getByText("Repository guide")).toBeInTheDocument()
        fireEvent.click(resource)
        await waitFor(() => expect(resource).toBeChecked())
        expectPatch(2, agent, {
            mcp: [{ server: "owner/github", tools: [], resources: ["repository://Instructions"] }],
            replaceMcp: true,
        })
        view.rerender(tree("en"))
        expect(checkbox("Use MCP resource owner/github/repository://Instructions")).toBe(resource)
        expect(resource).toBeChecked()
        expect(checkbox("Use MCP resource owner/github/repository://instructions")).not.toBeChecked()
        expect(screen.getByText("Reviews code")).toBeInTheDocument()
        expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("profile-a")
        expect(FileServiceClient.getAvailableTools).toHaveBeenCalledTimes(1)
        expect(FileServiceClient.getSubagentCapabilities).toHaveBeenCalledTimes(1)
        expect(FileServiceClient.getApiProfiles).toHaveBeenCalledTimes(1)
        expect(onToggle).not.toHaveBeenCalled()
    })

    it("retranslates pending and retained rollback errors, preserves diagnostics and retries the same patch", async () => {
        const agent = makeAgent()
        stored.set(agent.path, agent)
        const write = deferred<Empty>()
        vi.mocked(FileServiceClient.updateSubagentConfig).mockImplementationOnce(() => write.promise)
        const props = { agent, isGlobal: false, onToggle: vi.fn(), onDelete: vi.fn() }
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <SubagentRow {...props} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await expand()
        const choice = checkbox("Use search_files")
        fireEvent.click(choice)
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("status", { name: "子智能体配置保存状态" })).toHaveTextContent("正在保存子智能体配置")
        expect(checkbox("使用 search_files")).toBe(choice)
        expect(choice).toBeChecked()
        await act(async () => write.reject(new Error("Disk is read-only: C:\\workspace\\原始.yml")))
        expect(screen.getByRole("alert")).toHaveTextContent("失败的更改已回滚")
        expect(screen.getByRole("alert")).toHaveTextContent("Disk is read-only: C:\\workspace\\原始.yml")
        expect(choice).not.toBeChecked()
        view.rerender(tree("en"))
        expect(screen.getByRole("alert")).toHaveTextContent("Failed change was rolled back")
        expect(screen.getByRole("alert")).toHaveTextContent("Disk is read-only: C:\\workspace\\原始.yml")
        expect(checkbox("Use search_files")).toBe(choice)
        fireEvent.click(choice)
        await saved()
        expectPatch(2, agent, { tools: [...agent.tools, "search_files"], replaceTools: true })
        expect(stored.get(agent.path)?.tools).toEqual([...agent.tools, "search_files"])
    })
})
