import { PromptProfile } from "@core/prompts/profiles/types"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { DlineDefaultTool } from "@shared/tools"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseAgentConfigFromYaml } from "../AgentConfigLoader"
import { discoverSubagentCapabilities, resolveSubagentCapabilitySelection } from "../SubagentCapabilitySelection"

const ALL_TOOLS = [
    DlineDefaultTool.LOAD_SKILL,
    DlineDefaultTool.LOAD_WORKFLOW,
    DlineDefaultTool.LOAD_MCP,
    DlineDefaultTool.MCP_USE,
    DlineDefaultTool.MCP_ACCESS,
]

function agent(fields = "") {
    return parseAgentConfigFromYaml(
        `---\nname: reviewer\ndescription: Review the requested change\n${fields}\n---\nReview only the delegated request.`,
    )
}

function remoteEntry(name: string, contents: string, alwaysEnabled = false): GlobalInstructionsFile {
    return { name, contents, alwaysEnabled }
}

describe("SubagentCapabilitySelection workflow compatibility regression", () => {
    let temp: string
    let cwd: string
    let docs: string
    let config: TaskConfig
    let remote: {
        remoteGlobalRules: GlobalInstructionsFile[]
        remoteGlobalSkills: GlobalInstructionsFile[]
        remoteGlobalWorkflows: GlobalInstructionsFile[]
    }

    async function put(file: string, contents: string): Promise<string> {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, contents, "utf8")
        return file
    }

    function workflow(name: string, contents: string, scope: "workspace" | "global" = "workspace") {
        const root = scope === "workspace" ? path.join(cwd, ".agents", "workflows") : path.join(docs, "workflows")
        return put(path.join(root, name), contents)
    }

    beforeEach(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-workflows-"))
        cwd = path.join(temp, "workspace")
        docs = path.join(temp, "documents")
        await fs.mkdir(cwd, { recursive: true })
        await fs.mkdir(docs, { recursive: true })
        vi.stubEnv("DLINE_DOCS_DIR", docs)
        remote = { remoteGlobalRules: [], remoteGlobalSkills: [], remoteGlobalWorkflows: [] }
        config = {
            cwd,
            getMcpServersForOwner: () => [],
            services: {
                // Workflow discovery never consults the MCP Hub; the owner
                // projection above keeps even the fallback path unreachable.
                mcpHub: {
                    getAllServersForOwner: () => {
                        throw new Error("MCP Hub must not be consulted for workflow discovery")
                    },
                },
                stateManager: { getRemoteConfigSettings: () => remote },
            },
        } as unknown as TaskConfig
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await fs.rm(temp, { recursive: true, force: true })
    })

    it("reads ordinary markdown workflows with the legacy name and description fallbacks", async () => {
        await workflow("plain-steps.md", "1. Checkout the branch.\n2. Review the diff.")
        await workflow("named-flow.md", "---\nname: frontmatter-wins\ndescription: Frontmatter description\n---\nNamed steps.")
        await workflow("no-desc.md", "---\nname: no-desc\n---\nSteps without a description.")
        const catalog = await discoverSubagentCapabilities(config)
        const byName = new Map(catalog.workflows.map((entry) => [entry.name, entry]))
        expect(byName.get("frontmatter-wins")).toEqual(
            expect.objectContaining({
                name: "frontmatter-wins",
                description: "Frontmatter description",
                scope: "workspace",
                available: true,
            }),
        )
        expect(byName.get("no-desc")).toEqual(
            expect.objectContaining({ name: "no-desc", description: "", scope: "workspace", available: true }),
        )
        expect(byName.get("plain-steps")).toEqual(
            expect.objectContaining({ name: "plain-steps", description: "", scope: "workspace", available: true }),
        )
        expect(byName.get("named-flow")).toBeUndefined()
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("workflows: [frontmatter-wins, no-desc, plain-steps]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.workflows.map((entry) => [entry.name, entry.body])).toEqual([
            ["frontmatter-wins", "Named steps."],
            ["no-desc", "Steps without a description."],
            ["plain-steps", "1. Checkout the branch.\n2. Review the diff."],
        ])
    })

    it("keeps plain markdown frontmatter optional and filename fallback authoritative for missing names", async () => {
        await workflow("verify.md", "---\ndescription: Optional steps\n---\nVerify the change.")
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.workflows).toEqual([
            expect.objectContaining({ name: "verify", description: "Optional steps", available: true }),
        ])
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("workflows: [verify]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.workflows).toEqual([
            expect.objectContaining({ name: "verify", body: "Verify the change.", source: "project" }),
        ])
    })

    it("falls back to the filename when the frontmatter name is empty or whitespace only", async () => {
        await workflow("empty-name.md", '---\nname: ""\ndescription: Empty name\n---\nEmpty name steps.')
        await workflow("blank-name.md", "---\nname: '   '\n---\nBlank name steps.")
        const catalog = await discoverSubagentCapabilities(config)
        // An empty trimmed name is "no name" for the loader too, so the basename
        // must win instead of exposing an unusable empty selection name.
        expect(catalog.workflows).toEqual([
            expect.objectContaining({ name: "blank-name", description: "", scope: "workspace", available: true }),
            expect.objectContaining({ name: "empty-name", description: "Empty name", scope: "workspace", available: true }),
        ])
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("workflows: [empty-name, blank-name]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        // Selection keeps discovery order, which is the scan root's sorted order.
        expect(selected.workflows.map((entry) => [entry.name, entry.body])).toEqual([
            ["blank-name", "Blank name steps."],
            ["empty-name", "Empty name steps."],
        ])
    })

    it("retains fail-open behavior for unknown invalid frontmatter instead of demoting the file", async () => {
        const broken = await workflow("broken.md", "---\nname: [\n---\nBroken steps are retained.")
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.workflows).toEqual([
            expect.objectContaining({
                name: "broken",
                description: "",
                scope: "workspace",
                available: true,
                path: broken,
            }),
        ])
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("workflows: [broken]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.workflows).toHaveLength(1)
        expect(selected.workflows[0].body).toContain("Broken steps are retained.")
    })

    it("uses the stable remote name, keeps description optional, and honors alwaysEnabled", async () => {
        remote.remoteGlobalWorkflows = [
            remoteEntry("remote-verify", "---\ndescription: Remote verification\n---\nVerify remotely."),
            remoteEntry("plain-remote", "Plain remote steps without frontmatter."),
            remoteEntry("required-remote", "---\ndescription: Required remote\n---\nRequired steps.", true),
        ]
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.workflows).toEqual([
            expect.objectContaining({
                name: "remote-verify",
                description: "Remote verification",
                scope: "remote",
                path: "remote:remote-verify",
                required: false,
                available: true,
            }),
            expect.objectContaining({
                name: "plain-remote",
                description: "",
                scope: "remote",
                path: "remote:plain-remote",
                required: false,
                available: true,
            }),
            expect.objectContaining({
                name: "required-remote",
                description: "Required remote",
                scope: "remote",
                path: "remote:required-remote",
                required: true,
                available: true,
            }),
        ])
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("workflows: [remote-verify, plain-remote]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.workflows.map((entry) => [entry.name, entry.body, entry.source])).toEqual([
            ["remote-verify", "Verify remotely.", "remote"],
            ["plain-remote", "Plain remote steps without frontmatter.", "remote"],
            ["required-remote", "Required steps.", "remote"],
        ])
    })

    it.skipIf(process.platform === "win32")(
        "marks out-of-root workflow symlinks unavailable and ignores non-markdown files",
        async () => {
            const outside = await put(path.join(temp, "outside-steps.md"), "Outside steps.")
            const escapePath = path.join(cwd, ".agents", "workflows", "escape.md")
            await fs.mkdir(path.join(cwd, ".agents", "workflows"), { recursive: true })
            await fs.symlink(outside, escapePath)
            await workflow("notes.txt", "Not a workflow.")
            const catalog = await discoverSubagentCapabilities(config)
            expect(catalog.workflows.map((entry) => entry.name)).toEqual(["escape"])
            expect(catalog.workflows[0]).toEqual(
                expect.objectContaining({ available: false, unavailableReason: "Workflow is unreadable or outside its root." }),
            )
            const selected = await resolveSubagentCapabilitySelection(
                config,
                agent("workflows: [escape]"),
                "Review",
                ALL_TOOLS,
                PromptProfile.Standard,
            )
            expect(selected.workflows).toEqual([])
            expect(selected.capabilityToggles.localWorkflowToggles).toEqual({ [escapePath]: false })
        },
    )

    it("keeps project > global > remote name precedence when fallback names collide", async () => {
        await workflow("verify.md", "Workspace steps.")
        await workflow("verify.md", "---\ndescription: Global verification\n---\nGlobal steps.", "global")
        remote.remoteGlobalWorkflows = [remoteEntry("verify", "---\ndescription: Remote verification\n---\nRemote steps.")]
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.workflows).toEqual([expect.objectContaining({ name: "verify", scope: "workspace", description: "" })])
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("workflows: [verify]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.workflows.map((entry) => entry.body)).toEqual(["Workspace steps."])
        expect(selected.capabilityToggles.remoteWorkflowToggles).toEqual({ verify: false })
        expect(selected.capabilityToggles.globalWorkflowToggles).toEqual({ [path.join(docs, "workflows", "verify.md")]: false })
    })
})
