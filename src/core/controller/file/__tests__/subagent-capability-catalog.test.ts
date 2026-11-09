import type { Controller } from "@core/controller"
import { McpHub } from "@services/mcp/McpHub"
import type { McpServer } from "@shared/mcp"
import { GetSubagentCapabilitiesRequest, SubagentCapabilitiesResponse } from "@shared/proto/dline/file"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getSubagentCapabilities } from "../getSubagentCapabilities"

function hubWithOwners(): McpHub {
    const makeServer = (name: string, disabled = false, status: McpServer["status"] = "connected"): McpServer => ({
        name,
        source: "workspace",
        displayName: "Friendly server",
        config: '{"headers":{"Authorization":"CONFIG_SECRET"}}',
        status,
        disabled,
        tools: [
            { name: "read", description: "Read a record", inputSchema: { token: "SCHEMA_SECRET" } },
            { name: "write", description: "Write a record" },
        ],
        resources: [{ uri: "repo://policy", name: "Policy", description: "Repository policy" }],
        resourceTemplates: [{ uriTemplate: "repo://{name}", name: "Template" }],
        prompts: [{ name: "hidden-prompt" }],
        error: "CONFIG_SECRET",
    })
    const hub = Object.create(McpHub.prototype) as McpHub
    Object.assign(hub, {
        connections: [
            makeServer("docs@alpha"),
            makeServer("disabled@alpha", true),
            makeServer("offline@alpha", false, "disconnected"),
            makeServer("docs@beta"),
        ].map((server) => ({ server })),
        workspaceMcpRegistry: {
            getDescriptorsForOwner: (owner: string) =>
                owner === "owner-alpha"
                    ? ["docs@alpha", "disabled@alpha", "offline@alpha"].map((internalName) => ({ internalName }))
                    : [{ internalName: "docs@beta" }],
        },
    })
    return hub
}

describe("getSubagentCapabilities read-only independent candidate RPC", () => {
    let temp: string
    let workspace: string
    let secondWorkspace: string
    let docs: string
    let controller: Controller
    let remote: {
        remoteGlobalRules: GlobalInstructionsFile[]
        remoteGlobalSkills: GlobalInstructionsFile[]
        remoteGlobalWorkflows: GlobalInstructionsFile[]
    }
    let writes: ReturnType<typeof vi.fn>

    async function put(file: string, contents: string): Promise<string> {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, contents, "utf8")
        return file
    }

    function yaml(file: string, fields = "") {
        return put(file, `---\nname: reviewer\ndescription: Review code\ntools: []\n${fields}\n---\nSUBAGENT_BODY_SECRET`)
    }

    beforeEach(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-catalog-"))
        workspace = path.join(temp, "workspace")
        secondWorkspace = path.join(temp, "second-workspace")
        docs = path.join(temp, "documents")
        await Promise.all([workspace, secondWorkspace, docs].map((directory) => fs.mkdir(directory, { recursive: true })))
        vi.stubEnv("DLINE_DOCS_DIR", docs)
        remote = { remoteGlobalRules: [], remoteGlobalSkills: [], remoteGlobalWorkflows: [] }
        writes = vi.fn(() => {
            throw new Error("Candidate RPC must not mutate preferences")
        })
        controller = {
            getWorkspaceManager: () => ({
                getRoots: () => [{ path: workspace }, { path: secondWorkspace }],
                getPrimaryRoot: () => ({ path: workspace }),
            }),
            ensureWorkspaceMcpDescriptors: vi.fn().mockResolvedValue(undefined),
            mcpOwnerId: "owner-alpha",
            mcpHub: hubWithOwners(),
            stateManager: {
                getRemoteConfigSettings: () => remote,
                getGlobalStateKey: () => {
                    throw new Error("Parent toggles are not a discovery input")
                },
                getGlobalSettingsKey: () => {
                    throw new Error("Parent selection is not a discovery ceiling")
                },
                getWorkspaceStateKey: () => {
                    throw new Error("Workspace preferences must not be pruned or inherited")
                },
                setGlobalState: writes,
                setWorkspaceState: writes,
                mutateScopedCapabilityToggles: writes,
            },
            postStateToWebview: writes,
        } as unknown as Controller
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await fs.rm(temp, { recursive: true, force: true })
    })

    it("returns independent candidates through the real Proto codec, without instruction bodies, schemas, secrets or mutations", async () => {
        const agentPath = await yaml(path.join(docs, "subagents", "reviewer.yml"))
        await put(
            path.join(workspace, ".agents", "rules", "nested", "policy.md"),
            "---\ndescription: Workspace policy\n---\nRULE_BODY_SECRET",
        )
        await put(path.join(docs, "rules", "personal.md"), "GLOBAL_RULE_BODY_SECRET")
        await put(
            path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
            "---\nname: review\ndescription: Review changes\n---\nSKILL_BODY_SECRET",
        )
        await put(
            path.join(workspace, ".agents", "workflows", "verify.md"),
            "---\nname: verify\ndescription: Verify a change\n---\nWORKFLOW_BODY_SECRET",
        )
        remote.remoteGlobalRules = [{ name: "mandatory-policy", contents: "REMOTE_RULE_BODY_SECRET", alwaysEnabled: true }]
        remote.remoteGlobalSkills = [
            {
                name: "required-skill",
                contents: "---\nname: required-skill\ndescription: Required enterprise skill\n---\nREMOTE_SKILL_BODY_SECRET",
                alwaysEnabled: true,
            },
        ]
        const response = await getSubagentCapabilities(
            controller,
            GetSubagentCapabilitiesRequest.create({ subagentPath: agentPath }),
        )
        const decoded = SubagentCapabilitiesResponse.decode(SubagentCapabilitiesResponse.encode(response).finish())
        expect(
            decoded.rules.map(({ scope, path: selectedPath, required, available }) => ({
                scope,
                path: selectedPath,
                required,
                available,
            })),
        ).toEqual([
            { scope: "global", path: "personal.md", required: false, available: true },
            { scope: "workspace", path: "nested/policy.md", required: false, available: true },
            { scope: "remote", path: "mandatory-policy", required: true, available: true },
        ])
        expect(decoded.skills.map(({ name, scope, required }) => ({ name, scope, required }))).toEqual([
            { name: "required-skill", scope: "remote", required: true },
            { name: "review", scope: "workspace", required: false },
        ])
        expect(decoded.workflows.map((entry) => entry.name)).toEqual(["verify"])
        expect(decoded.mcp.map((entry) => [entry.name, entry.available])).toEqual([
            ["docs@alpha", true],
            ["disabled@alpha", false],
            ["offline@alpha", false],
        ])
        expect(decoded.mcp[0].tools).toEqual([
            { name: "read", description: "Read a record" },
            { name: "write", description: "Write a record" },
        ])
        expect(decoded.mcp[0].resources).toEqual([{ uri: "repo://policy", name: "Policy", description: "Repository policy" }])
        expect(JSON.stringify(decoded)).not.toMatch(
            /BODY_SECRET|CONFIG_SECRET|SCHEMA_SECRET|inputSchema|resourceTemplates|hidden-prompt|docs@beta/,
        )
        expect(writes).not.toHaveBeenCalled()
    })

    it("uses the owning workspace for project YAML and the Controller workspace for global YAML, never the YAML directory as cwd", async () => {
        const globalAgent = await yaml(path.join(docs, "subagents", "global.yml"))
        const projectAgent = await yaml(path.join(secondWorkspace, ".agents", "subagents", "project.yml"))
        await put(path.join(workspace, ".agents", "rules", "primary.md"), "Primary body.")
        await put(path.join(secondWorkspace, ".agents", "rules", "second.md"), "Second body.")
        await put(path.join(docs, "subagents", ".agents", "rules", "wrong-cwd.md"), "Wrong cwd body.")
        const globalCatalog = await getSubagentCapabilities(
            controller,
            GetSubagentCapabilitiesRequest.create({ subagentPath: globalAgent }),
        )
        const localCatalog = await getSubagentCapabilities(
            controller,
            GetSubagentCapabilitiesRequest.create({ subagentPath: projectAgent }),
        )
        expect(globalCatalog.rules.map((entry) => entry.path)).toEqual(["primary.md"])
        expect(localCatalog.rules.map((entry) => entry.path)).toEqual(["second.md"])
        await expect(fs.access(path.join(docs, "rules"))).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(path.join(docs, "skills"))).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(path.join(docs, "workflows"))).rejects.toMatchObject({ code: "ENOENT" })
        expect(writes).not.toHaveBeenCalled()
    })

    it("retains missing selections, but never substitutes aliases or leaks another owner's MCP catalog", async () => {
        const agentPath = await yaml(
            path.join(workspace, ".agents", "subagents", "reviewer.yml"),
            `rules: [{scope: workspace, path: removed.md}]\nskills: [removed-skill]\nworkflows: [removed-flow]\nmcp:\n  - server: docs@beta\n    tools: [guessed]\n    resources: [repo://guessed]\n  - server: docs@alpha\n    tools: [read, removed-tool]\n    resources: ["repo://policy/"]`,
        )
        const response = await getSubagentCapabilities(
            controller,
            GetSubagentCapabilitiesRequest.create({ subagentPath: agentPath }),
        )
        expect(response.rules).toEqual([
            expect.objectContaining({ scope: "workspace", path: "removed.md", available: false, required: false }),
        ])
        expect(response.skills).toEqual([expect.objectContaining({ name: "removed-skill", scope: "unknown", available: false })])
        expect(response.workflows).toEqual([
            expect.objectContaining({ name: "removed-flow", scope: "unknown", available: false }),
        ])
        const otherOwner = response.mcp.find((entry) => entry.name === "docs@beta")!
        expect(otherOwner.available).toBe(false)
        expect(otherOwner.displayName).toBe("docs@beta")
        expect(otherOwner.tools).toEqual([{ name: "guessed", description: "" }])
        expect(otherOwner.resources).toEqual([{ uri: "repo://guessed", name: "repo://guessed", description: "" }])
        const missingTool = response.mcp.find((entry) => entry.name === "docs@alpha")!
        expect(missingTool.available).toBe(true)
        expect(missingTool.unavailableReason).toBeUndefined()
        expect(missingTool.tools.map((entry) => entry.name)).toEqual(["read", "write"])
        expect(missingTool.resources.map((entry) => entry.uri)).toEqual(["repo://policy"])
        expect(response.mcp.map((entry) => entry.name)).toEqual(["docs@alpha", "disabled@alpha", "offline@alpha", "docs@beta"])
        expect(writes).not.toHaveBeenCalled()
    })

    it("uses existing name precedence rather than returning duplicate shadowed skill/workflow candidates", async () => {
        const agentPath = await yaml(path.join(docs, "subagents", "reviewer.yml"))
        for (const root of [path.join(workspace, ".agents"), docs]) {
            await put(
                path.join(root, "skills", "review", "SKILL.md"),
                `---\nname: review\ndescription: ${root === docs ? "Personal" : "Workspace"} review\n---\nSkill body.`,
            )
            await put(
                path.join(root, "workflows", "verify.md"),
                `---\nname: verify\ndescription: ${root === docs ? "Personal" : "Workspace"} verification\n---\nWorkflow body.`,
            )
        }
        const response = await getSubagentCapabilities(
            controller,
            GetSubagentCapabilitiesRequest.create({ subagentPath: agentPath }),
        )
        expect(response.skills).toEqual([
            expect.objectContaining({ name: "review", scope: "workspace", description: "Workspace review" }),
        ])
        expect(response.workflows).toEqual([
            expect.objectContaining({ name: "verify", scope: "workspace", description: "Workspace verification" }),
        ])
    })

    it("rejects an arbitrary YAML request before reading its contents", async () => {
        const outside = await yaml(path.join(temp, "unowned.yml"))
        const reads = vi.spyOn(fs, "readFile")
        await expect(
            getSubagentCapabilities(controller, GetSubagentCapabilitiesRequest.create({ subagentPath: outside })),
        ).rejects.toThrow(/outside the owned subagent directories/)
        expect(reads.mock.calls.some(([file]) => String(file) === outside)).toBe(false)
        await expect(
            getSubagentCapabilities(controller, GetSubagentCapabilitiesRequest.create({ subagentPath: "../unowned.yml" })),
        ).rejects.toThrow(/existing subagent YAML/)
    })

    it("rejects a subagent directory symlink/junction outside its owner before parsing YAML", async () => {
        const outsideRoot = path.join(temp, "unowned-subagents")
        const outside = await yaml(path.join(outsideRoot, "reviewer.yml"))
        await fs.mkdir(path.join(workspace, ".agents"), { recursive: true })
        const localRoot = path.join(workspace, ".agents", "subagents")
        await fs.symlink(outsideRoot, localRoot, process.platform === "win32" ? "junction" : "dir")
        const reads = vi.spyOn(fs, "readFile")
        await expect(
            getSubagentCapabilities(
                controller,
                GetSubagentCapabilitiesRequest.create({ subagentPath: path.join(localRoot, "reviewer.yml") }),
            ),
        ).rejects.toThrow(/resolves outside its owned subagent directory/)
        expect(reads.mock.calls.some(([file]) => String(file) === outside)).toBe(false)
    })
})
