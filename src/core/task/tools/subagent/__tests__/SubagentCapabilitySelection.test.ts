import * as skillDiscovery from "@core/context/instructions/user-instructions/skills"
import { getSkillContent } from "@core/context/instructions/user-instructions/skills"
import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { createSystemPromptConfig, prepareSystemRuntimeEnv } from "@core/prompts/system-prompt/pipeline"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { McpHub } from "@services/mcp/McpHub"
import type { McpServer } from "@shared/mcp"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { emptyTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { DlineDefaultTool } from "@shared/tools"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { type AgentRuleSelection, parseAgentConfigFromYaml } from "../AgentConfigLoader"
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

function remoteEntry(name: string, body: string, alwaysEnabled = false): GlobalInstructionsFile {
    return { name, contents: body, alwaysEnabled }
}

function server(name: string, source: McpServer["source"] = "workspace", overrides: Partial<McpServer> = {}): McpServer {
    return {
        name,
        displayName: "Shared display name",
        source,
        status: "connected",
        config: '{"token":"CONFIG_SECRET"}',
        tools: [
            {
                name: "read",
                description: "Read a record",
                inputSchema: { type: "object", properties: { id: { type: "string" } } },
                autoApprove: true,
            },
            { name: "write", description: "Write a record" },
        ],
        resources: [
            { uri: "repo://policy", name: "Policy", description: "Repository policy" },
            { uri: "repo://private", name: "Private" },
        ],
        resourceTemplates: [{ uriTemplate: "repo://{name}", name: "Every record" }],
        prompts: [{ name: "private-prompt", description: "Not selected" }],
        ...overrides,
    }
}

/** Real owner-scoping methods, without opening transports or starting Hub watchers. */
function scopedHub(servers: McpServer[]): McpHub {
    const hub = Object.create(McpHub.prototype) as McpHub
    Object.assign(hub, {
        connections: servers.map((entry) => ({ server: entry })),
        workspaceMcpRegistry: {
            getDescriptorsForOwner: (owner: string) =>
                owner === "owner-alpha"
                    ? servers
                          .filter((entry) => entry.source === "workspace" && entry.name.endsWith("@alpha"))
                          .map((entry) => ({ internalName: entry.name }))
                    : [],
        },
    })
    return hub
}

describe("SubagentCapabilitySelection independent run snapshot", () => {
    let temp: string
    let cwd: string
    let docs: string
    let config: TaskConfig
    let servers: McpServer[]
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

    function rule(name: string, contents: string, scope: "workspace" | "global" = "workspace") {
        return put(
            path.join(scope === "workspace" ? path.join(cwd, ".agents", "rules") : path.join(docs, "rules"), name),
            contents,
        )
    }

    function skill(name: string, body: string, scope: "workspace" | "global" = "workspace") {
        const root = scope === "workspace" ? path.join(cwd, ".agents", "skills") : path.join(docs, "skills")
        return put(
            path.join(root, name, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${scope} ${name} instructions\n---\n${body}`,
        )
    }

    function workflow(name: string, body: string, scope: "workspace" | "global" = "workspace") {
        const root = scope === "workspace" ? path.join(cwd, ".agents", "workflows") : path.join(docs, "workflows")
        return put(path.join(root, `${name}.md`), `---\nname: ${name}\ndescription: ${scope} ${name} steps\n---\n${body}`)
    }

    beforeEach(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-selection-"))
        cwd = path.join(temp, "workspace")
        docs = path.join(temp, "documents")
        await fs.mkdir(cwd, { recursive: true })
        await fs.mkdir(docs, { recursive: true })
        vi.stubEnv("DLINE_DOCS_DIR", docs)
        remote = { remoteGlobalRules: [], remoteGlobalSkills: [], remoteGlobalWorkflows: [] }
        servers = [
            server("settings", "settings"),
            server("docs@alpha"),
            server("docs@beta"),
            server("disabled@alpha", "workspace", { disabled: true }),
            server("offline@alpha", "workspace", { status: "disconnected", error: "CONFIG_SECRET" }),
        ]
        const hub = scopedHub(servers)
        config = {
            cwd,
            capabilityToggles: emptyTaskCapabilityToggles(),
            getMcpServersForOwner: () => hub.getAllServersForOwner("owner-alpha"),
            services: {
                mcpHub: hub,
                stateManager: {
                    getRemoteConfigSettings: () => remote,
                    getGlobalStateKey: () => {
                        throw new Error("Parent remote toggles must not be read")
                    },
                    getGlobalSettingsKey: () => {
                        throw new Error("Parent selection must not be read")
                    },
                    getWorkspaceStateKey: () => {
                        throw new Error("Parent preferences must not be read")
                    },
                },
            },
        } as unknown as TaskConfig
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await fs.rm(temp, { recursive: true, force: true })
    })

    it("discovers and resolves parent-unselected resources, but does not grant parent-only or sibling selections", async () => {
        const childRule = await rule("child.md", "Child rule body.")
        const parentRule = await rule("parent.md", "Parent-only rule body.")
        const childSkill = await skill("review", "Inspect the delegated diff.")
        const parentSkill = await skill("parent-only", "Parent-only skill instructions.")
        const childWorkflow = await workflow("verify", "1. Inspect.\n2. Verify.")
        config.capabilityToggles.localClineRulesToggles = { [childRule]: false, [parentRule]: true }
        config.capabilityToggles.localSkillsToggles = { [childSkill]: false, [parentSkill]: true }
        config.capabilityToggles.localWorkflowToggles[childWorkflow] = false
        config.capabilityToggles.mcpServers["docs@alpha"] = false
        config.getMcpServersForOwner = () => config.services.mcpHub.getServersForOwner("owner-alpha")
        const originalParent = structuredClone(config.capabilityToggles)
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.skills.map((entry) => entry.name).sort()).toEqual(["parent-only", "review"])
        expect(catalog.rules.map((entry) => entry.path)).toEqual(["child.md", "parent.md"])
        expect(catalog.workflows.map((entry) => entry.name)).toEqual(["verify"])
        const child = await resolveSubagentCapabilitySelection(
            config,
            agent(
                `rules:\n  - scope: workspace\n    path: child.md\nskills: [review]\nworkflows: [verify]\nmcp:\n  - server: docs@alpha\n    tools: [read]\n    resources: [repo://policy]`,
            ),
            "Review src/child.ts",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(child.skills.map((entry) => entry.name)).toEqual(["review"])
        expect((await getSkillContent("review", child.skills, child.remoteSkillEntries))?.instructions).toBe(
            "Inspect the delegated diff.",
        )
        expect(await getSkillContent("parent-only", child.skills, child.remoteSkillEntries)).toBeNull()
        expect(child.workflows).toEqual([
            {
                name: "verify",
                description: "workspace verify steps",
                path: childWorkflow,
                source: "project",
                body: "1. Inspect.\n2. Verify.",
            },
        ])
        // Rule bodies are formatted through the existing rule helpers, whose
        // header uses the host's native path separators; expected text follows.
        expect(child.ruleInstructions.localClineRulesFileInstructions).toContain(
            `${path.join(".agents", "rules", "child.md")}\nChild rule body.`,
        )
        expect(child.ruleInstructions.localClineRulesFileInstructions).not.toContain("Parent-only rule body.")
        expect(child.capabilityToggles.localClineRulesToggles).toEqual({ [childRule]: true, [parentRule]: false })
        expect(child.capabilityToggles.localSkillsToggles).toEqual({ [childSkill]: true, [parentSkill]: false })
        expect(child.capabilities.skills.map((entry) => entry.name)).toEqual(["review"])
        expect(child.capabilities.workflows.map((entry) => entry.name)).toEqual(["verify"])
        expect(child.capabilities.mcp.map((entry) => entry.name)).toEqual(["docs@alpha.read"])
        expect(child.capabilities.subagents).toEqual([])
        const sibling = await resolveSubagentCapabilitySelection(
            config,
            agent("rules: [{scope: workspace, path: parent.md}]\nskills: [parent-only]"),
            "Review docs/guide.md",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(sibling.skills.map((entry) => entry.name)).toEqual(["parent-only"])
        expect(sibling.ruleInstructions.localClineRulesFileInstructions).not.toContain("Child rule body.")
        expect(child.skills.map((entry) => entry.name)).toEqual(["review"])
        expect(sibling.capabilityToggles).not.toBe(child.capabilityToggles)
        expect(config.capabilityToggles).toEqual(originalParent)
    })

    it.each([
        "",
        "rules: []\nskills: []\nworkflows: []\nmcp: []",
    ])("treats omitted and legacy empty lists as unselected (%s)", async (fields) => {
        await rule("available.md", "Not selected.")
        const skillPath = await skill("available", "Not selected.")
        const workflowPath = await workflow("available", "Not selected.")
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent(fields),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.skills).toEqual([])
        expect(selected.workflows).toEqual([])
        expect(selected.remoteSkillEntries).toEqual([])
        expect(selected.mcpServers).toEqual([])
        expect(selected.capabilities).toEqual({ skills: [], workflows: [], mcp: [], subagents: [] })
        expect(selected.ruleInstructions).toEqual({
            globalClineRulesFileInstructions: undefined,
            localClineRulesFileInstructions: undefined,
        })
        expect(selected.capabilityToggles.localSkillsToggles[skillPath]).toBe(false)
        expect(selected.capabilityToggles.localWorkflowToggles[workflowPath]).toBe(false)
        expect(Object.values(selected.capabilityToggles.mcpServers).every((enabled) => !enabled)).toBe(true)
    })

    it("separates mandatory enterprise entries from ordinary defaults, and evaluates mandatory rule conditions against child text", async () => {
        remote.remoteGlobalRules = [
            remoteEntry("mandatory-policy", "---\npaths: [src/**]\n---\nMandatory rule body.", true),
            remoteEntry("optional-policy", "Optional remote rule body."),
        ]
        remote.remoteGlobalSkills = [
            remoteEntry(
                "mandatory-skill",
                "---\nname: mandatory-skill\ndescription: Enterprise validation\n---\nEnterprise validation body.",
                true,
            ),
            remoteEntry("optional-skill", "---\nname: optional-skill\ndescription: Optional work\n---\nOptional body."),
        ]
        remote.remoteGlobalWorkflows = [
            remoteEntry("mandatory-flow", "---\ndescription: Enterprise workflow\n---\nEnterprise workflow body.", true),
            remoteEntry("optional-flow", "---\ndescription: Optional workflow\n---\nOptional steps."),
        ]
        await skill("mandatory-skill", "Do not replace enterprise instructions.")
        await workflow("mandatory-flow", "Do not replace enterprise steps.")
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.skills.filter((entry) => entry.name === "mandatory-skill")).toEqual([
            expect.objectContaining({ scope: "remote", required: true }),
        ])
        expect(catalog.workflows.filter((entry) => entry.name === "mandatory-flow")).toEqual([
            expect.objectContaining({ scope: "remote", required: true }),
        ])
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent(),
            "Review src/child.ts",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.skills.map((entry) => entry.name)).toEqual(["mandatory-skill"])
        expect((await getSkillContent("mandatory-skill", selected.skills, selected.remoteSkillEntries))?.instructions).toBe(
            "Enterprise validation body.",
        )
        expect(selected.workflows.map((entry) => entry.body)).toEqual(["Enterprise workflow body."])
        expect(selected.remoteSkillEntries.map((entry) => entry.name)).toEqual(["mandatory-skill"])
        expect(selected.ruleInstructions.globalClineRulesFileInstructions).toContain("mandatory-policy\nMandatory rule body.")
        expect(selected.ruleInstructions.globalClineRulesFileInstructions).not.toContain("Optional remote rule body.")
        expect(selected.capabilityToggles.remoteRulesToggles).toEqual({ "mandatory-policy": true, "optional-policy": false })
        const noChildEvidence = await resolveSubagentCapabilitySelection(
            config,
            agent(),
            "Review docs/guide.md",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(noChildEvidence.ruleInstructions.globalClineRulesFileInstructions).toBeUndefined()
        remote.remoteGlobalSkills[0].contents = "Changed after run start."
        expect((await getSkillContent("mandatory-skill", selected.skills, selected.remoteSkillEntries))?.instructions).toBe(
            "Enterprise validation body.",
        )
    })

    it("does not turn missing selected names or an empty MCP server item into all available capabilities", async () => {
        await skill("available", "Available skill body.")
        await workflow("available", "Available workflow steps.")
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("skills: [missing]\nworkflows: [missing]\nmcp: [{server: docs@alpha}]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.skills).toEqual([])
        expect(selected.workflows).toEqual([])
        expect(selected.mcpServers).toEqual([])
        expect(selected.capabilities).toEqual({ skills: [], workflows: [], mcp: [], subagents: [] })
        expect(selected.capabilityToggles.mcpServers["docs@alpha"]).toBe(false)
    })

    it("loads only explicitly selected ordinary remote entries using canonical skill identity", async () => {
        remote.remoteGlobalSkills = [
            remoteEntry(
                "dashboard-name",
                "---\nname: canonical-review\ndescription: Review remotely\n---\nCanonical remote instructions.",
            ),
        ]
        remote.remoteGlobalWorkflows = [
            remoteEntry("remote-verify", "---\ndescription: Remote verification\n---\nRemote verification steps."),
        ]
        remote.remoteGlobalRules = [remoteEntry("remote-policy", "Remote policy instructions.")]
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("skills: [canonical-review]\nworkflows: [remote-verify]\nrules: [{scope: remote, path: remote-policy}]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.skills.map((entry) => entry.name)).toEqual(["canonical-review"])
        expect(selected.remoteSkillEntries.map((entry) => entry.name)).toEqual(["canonical-review"])
        expect((await getSkillContent("canonical-review", selected.skills, selected.remoteSkillEntries))?.instructions).toBe(
            "Canonical remote instructions.",
        )
        expect(selected.workflows.map((entry) => entry.body)).toEqual(["Remote verification steps."])
        expect(selected.ruleInstructions.globalClineRulesFileInstructions).toContain("remote-policy\nRemote policy instructions.")
    })

    it("records external names as own independent toggle keys rather than object prototype properties", async () => {
        remote.remoteGlobalSkills = [
            remoteEntry("__proto__", "---\nname: __proto__\ndescription: Prototype-named skill\n---\nNot selected."),
        ]
        const selected = await resolveSubagentCapabilitySelection(config, agent(), "Review", ALL_TOOLS, PromptProfile.Standard)
        expect(selected.skills).toEqual([])
        expect(Object.hasOwn(selected.capabilityToggles.remoteSkillsToggles, "__proto__")).toBe(true)
        expect(selected.capabilityToggles.remoteSkillsToggles.__proto__).toBe(false)
    })

    it("uses child-only condition evidence and preserves existing frontmatter fail-open behavior", async () => {
        await rule("scoped.md", "---\npaths: [src/**]\n---\nScoped child instructions.")
        await rule("invalid.md", "---\npaths: [\n---\nMalformed frontmatter is retained.")
        const openTabs = vi.spyOn(HostProvider.window, "getOpenTabs")
        const visibleTabs = vi.spyOn(HostProvider.window, "getVisibleTabs")
        Object.assign(config, { messageState: { clineMessages: [{ type: "say", say: "task", text: "Edit src/parent.ts" }] } })
        const request = agent("rules: [{scope: workspace, path: scoped.md}, {scope: workspace, path: invalid.md}]")
        const noEvidence = await resolveSubagentCapabilitySelection(
            config,
            request,
            "Inspect docs/readme.md\n```\nsrc/pasted.ts\n```",
            [],
            PromptProfile.Lite,
        )
        expect(noEvidence.ruleInstructions.localClineRulesFileInstructions).not.toContain("Scoped child instructions.")
        expect(noEvidence.ruleInstructions.localClineRulesFileInstructions).toContain(
            "paths: [\n---\nMalformed frontmatter is retained.",
        )
        const withEvidence = await resolveSubagentCapabilitySelection(
            config,
            request,
            "Inspect src/child.ts",
            [],
            PromptProfile.Lite,
        )
        expect(withEvidence.ruleInstructions.localClineRulesFileInstructions).toContain("Scoped child instructions.")
        expect(openTabs).not.toHaveBeenCalled()
        expect(visibleTabs).not.toHaveBeenCalled()
    })

    it.each([
        PromptProfile.Standard,
        PromptProfile.Lite,
    ])("feeds selected disk and remote rule bodies through the existing %s system context without loaders", async (profile) => {
        await rule("common.md", "Personal policy body.", "global")
        await rule("common.md", "Workspace policy body.")
        remote.remoteGlobalRules = [
            remoteEntry("stable-remote-name", "---\nname: a-different-frontmatter-name\n---\nRemote policy body."),
        ]
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent(
                "rules: [{scope: global, path: common.md}, {scope: workspace, path: common.md}, {scope: remote, path: stable-remote-name}]",
            ),
            "Review",
            [],
            profile,
        )
        const context: SystemPromptContext = {
            ide: "Test IDE",
            cwd,
            promptProfile: profile,
            isSubagentRun: true,
            providerInfo: { providerId: "cline", model: { id: "test", info: { id: "test" } }, mode: "act" },
            ...selected.ruleInstructions,
        }
        const environment = prepareSystemRuntimeEnv(context, createSystemPromptConfig(context))
        const instructions = String(environment.CUSTOM_INSTRUCTIONS)
        expect(instructions).toContain("common.md\nPersonal policy body.")
        expect(instructions).toContain(`${path.join(".agents", "rules", "common.md")}\nWorkspace policy body.`)
        expect(instructions).toContain("stable-remote-name\nRemote policy body.")
        expect(instructions).not.toContain("a-different-frontmatter-name")
        expect(instructions.split("Workspace policy body.")).toHaveLength(2)
    })

    it.each([
        "../outside.md",
        "nested/../../outside.md",
        "/outside.md",
        "C:\\outside.md",
        "\\\\host\\share\\outside.md",
    ])("rejects a rule escape before reading its body: %s", async (selectedPath) => {
        const outside = await put(path.join(temp, "outside.md"), "Outside secret.")
        const reads = vi.spyOn(fs, "readFile")
        await expect(
            resolveSubagentCapabilitySelection(
                config,
                { rules: [{ scope: "workspace", path: selectedPath } as AgentRuleSelection] },
                "Review",
                ALL_TOOLS,
                PromptProfile.Standard,
            ),
        ).rejects.toThrow(/relative to its rule root/)
        expect(reads.mock.calls.some(([file]) => String(file) === outside)).toBe(false)
    })

    it("fails only the child with a missing or unreadable explicit rule, not other children", async () => {
        await expect(
            resolveSubagentCapabilitySelection(
                config,
                agent("rules: [{scope: workspace, path: missing.md}]"),
                "Review",
                [],
                PromptProfile.Standard,
            ),
        ).rejects.toThrow(/workspace:missing.md.*unavailable/)
        await rule("unreadable.md", "Unreadable instructions.")
        const reads = vi
            .spyOn(fs, "readFile")
            .mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }))
        await expect(
            resolveSubagentCapabilitySelection(
                config,
                agent("rules: [{scope: workspace, path: unreadable.md}]"),
                "Review",
                [],
                PromptProfile.Standard,
            ),
        ).rejects.toThrow(/workspace:unreadable.md.*unavailable/)
        reads.mockRestore()
        const sibling = await resolveSubagentCapabilitySelection(config, agent(), "Review", [], PromptProfile.Standard)
        expect(sibling.ruleInstructions.localClineRulesFileInstructions).toBeUndefined()
    })

    it("fails a child if a selected rule becomes unreadable after catalog discovery", async () => {
        await rule("policy.md", "First policy body.")
        const reads = vi
            .spyOn(fs, "readFile")
            .mockResolvedValueOnce("First policy body.")
            .mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }))
        await expect(
            resolveSubagentCapabilitySelection(
                config,
                agent("rules: [{scope: workspace, path: policy.md}]"),
                "Review",
                [],
                PromptProfile.Standard,
            ),
        ).rejects.toThrow(/workspace:policy.md.*could not be read safely/)
        reads.mockRestore()
        const sibling = await resolveSubagentCapabilitySelection(config, agent(), "Review", [], PromptProfile.Standard)
        expect(sibling.ruleInstructions.localClineRulesFileInstructions).toBeUndefined()
    })

    it("does not read rules through a root symlink/junction outside its workspace owner", async () => {
        const outsideRoot = path.join(temp, "outside-rules")
        const outside = await put(path.join(outsideRoot, "secret.md"), "Outside secret.")
        await fs.mkdir(path.join(cwd, ".agents"), { recursive: true })
        await fs.symlink(outsideRoot, path.join(cwd, ".agents", "rules"), process.platform === "win32" ? "junction" : "dir")
        const reads = vi.spyOn(fs, "readFile")
        await expect(
            resolveSubagentCapabilitySelection(
                config,
                agent("rules: [{scope: workspace, path: secret.md}]"),
                "Review",
                [],
                PromptProfile.Standard,
            ),
        ).rejects.toThrow(/workspace:secret.md.*unavailable/)
        expect(reads.mock.calls.some(([file]) => String(file) === outside)).toBe(false)
    })

    it.skipIf(process.platform === "win32")(
        "rejects an out-of-root file symlink but accepts a root-contained file symlink",
        async () => {
            const target = await rule("inside.md", "Inside policy body.")
            const outside = await put(path.join(temp, "secret.md"), "Outside secret.")
            await fs.symlink(outside, path.join(cwd, ".agents", "rules", "escape.md"))
            await fs.symlink(target, path.join(cwd, ".agents", "rules", "alias.md"))
            const catalog = await discoverSubagentCapabilities(config)
            expect(catalog.rules.find((entry) => entry.path === "escape.md")?.available).toBe(false)
            await expect(
                resolveSubagentCapabilitySelection(
                    config,
                    agent("rules: [{scope: workspace, path: escape.md}]"),
                    "Review",
                    [],
                    PromptProfile.Standard,
                ),
            ).rejects.toThrow(/workspace:escape.md.*unavailable/)
            const selected = await resolveSubagentCapabilitySelection(
                config,
                agent("rules: [{scope: workspace, path: alias.md}, {scope: workspace, path: inside.md}]"),
                "Review",
                [],
                PromptProfile.Standard,
            )
            expect(selected.ruleInstructions.localClineRulesFileInstructions).toContain("Inside policy body.")
            expect(selected.ruleInstructions.localClineRulesFileInstructions?.split("Inside policy body.")).toHaveLength(2)
            expect(selected.ruleInstructions.localClineRulesFileInstructions).not.toContain("Outside secret.")
        },
    )

    it("uses existing workspace-first skill and workflow name resolution, without exposing shadowed entries", async () => {
        remote.remoteGlobalSkills = [
            remoteEntry("review", "---\nname: review\ndescription: Enterprise review\n---\nEnterprise body."),
        ]
        remote.remoteGlobalWorkflows = [remoteEntry("verify", "---\ndescription: Enterprise verify\n---\nEnterprise steps.")]
        await skill("review", "Personal body.", "global")
        const localSkill = await skill("review", "Workspace body.")
        await workflow("verify", "Personal steps.", "global")
        const localWorkflow = await workflow("verify", "Workspace steps.")
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.skills).toEqual([expect.objectContaining({ name: "review", scope: "workspace", path: localSkill })])
        expect(catalog.workflows).toEqual([expect.objectContaining({ name: "verify", scope: "workspace", path: localWorkflow })])
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("skills: [review]\nworkflows: [verify]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect((await getSkillContent("review", selected.skills, selected.remoteSkillEntries))?.instructions).toBe(
            "Workspace body.",
        )
        expect(selected.workflows.map((entry) => entry.body)).toEqual(["Workspace steps."])
        expect(selected.remoteSkillEntries).toEqual([])
        expect(selected.capabilityToggles.remoteSkillsToggles.review).toBe(false)
        expect(selected.capabilityToggles.remoteWorkflowToggles.verify).toBe(false)
    })

    it("enforces real MCP ownership, exact internal server/tool/URI identity and a secret-free detached projection", async () => {
        const getUnscoped = vi.spyOn(config.services.mcpHub, "getServers").mockImplementation(() => {
            throw new Error("Unscoped Hub reads are forbidden")
        })
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.mcp.map((entry) => entry.name)).toEqual(["settings", "docs@alpha", "disabled@alpha", "offline@alpha"])
        expect(catalog.mcp.filter((entry) => !entry.available).map((entry) => entry.name)).toEqual([
            "disabled@alpha",
            "offline@alpha",
        ])
        expect(JSON.stringify(catalog)).not.toMatch(/CONFIG_SECRET|inputSchema|resourceTemplates|private-prompt/)
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent(
                `mcp:\n  - server: docs@alpha\n    tools: [read, Read]\n    resources: [repo://policy, "repo://policy/", "repo://guessed"]\n  - server: docs@beta\n    tools: [write]\n  - server: Shared display name\n    tools: [write]`,
            ),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.mcpServers).toHaveLength(1)
        expect(selected.mcpServers[0].name).toBe("docs@alpha")
        expect(selected.mcpServers[0].tools?.map((tool) => tool.name)).toEqual(["read"])
        expect(selected.mcpServers[0].resources?.map((resource) => resource.uri)).toEqual(["repo://policy"])
        expect(selected.mcpServers[0].config).toBe("{}")
        expect(selected.mcpServers[0]).not.toHaveProperty("resourceTemplates")
        expect(selected.mcpServers[0]).not.toHaveProperty("prompts")
        expect(selected.mcpServers[0].tools?.[0]).not.toHaveProperty("autoApprove")
        expect(selected.capabilityToggles.mcpServers["docs@beta"]).toBe(false)
        expect(selected.capabilityToggles.mcpServers["Shared display name"]).toBe(false)
        expect(selected.mcpServers[0].tools?.[0].inputSchema).not.toBe(servers[1].tools?.[0].inputSchema)
        servers[1].tools![0].inputSchema = { type: "number" }
        expect(selected.mcpServers[0].tools?.[0].inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } })
        expect(Object.isFrozen(selected)).toBe(true)
        expect(Object.isFrozen(selected.mcpServers[0].tools?.[0].inputSchema)).toBe(true)
        expect(Object.isFrozen(selected.capabilityToggles.mcpServers)).toBe(true)
        expect(Object.isFrozen(servers[1])).toBe(false)
        expect(getUnscoped).not.toHaveBeenCalled()
    })

    it("retains selected disabled/disconnected MCP metadata, but does not advertise or enable it", async () => {
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent("mcp: [{server: disabled@alpha, tools: [read]}, {server: offline@alpha, resources: [repo://policy]}]"),
            "Review",
            ALL_TOOLS,
            PromptProfile.Standard,
        )
        expect(selected.mcpServers.map((entry) => entry.name)).toEqual(["disabled@alpha", "offline@alpha"])
        expect(selected.capabilities.mcp).toEqual([])
        expect(selected.capabilityToggles.mcpServers["disabled@alpha"]).toBe(false)
        expect(selected.capabilityToggles.mcpServers["offline@alpha"]).toBe(false)
        expect(JSON.stringify(selected)).not.toContain("CONFIG_SECRET")
    })

    it("fails closed to settings MCP when the host has not supplied an owner, without guessing a storage workspace ID", async () => {
        Reflect.deleteProperty(config, "getMcpServersForOwner")
        const catalog = await discoverSubagentCapabilities(config)
        expect(catalog.mcp.map((entry) => entry.name)).toEqual(["settings"])
    })

    it.each([
        { absent: DlineDefaultTool.LOAD_SKILL, skillCount: 0, workflowCount: 1, toolCount: 1, resourceCount: 1 },
        { absent: DlineDefaultTool.LOAD_WORKFLOW, skillCount: 1, workflowCount: 0, toolCount: 1, resourceCount: 1 },
        { absent: DlineDefaultTool.LOAD_MCP, skillCount: 1, workflowCount: 1, toolCount: 0, resourceCount: 1 },
        { absent: DlineDefaultTool.MCP_USE, skillCount: 1, workflowCount: 1, toolCount: 0, resourceCount: 1 },
        { absent: DlineDefaultTool.MCP_ACCESS, skillCount: 1, workflowCount: 1, toolCount: 1, resourceCount: 0 },
    ])("applies the child $absent gate while preserving other capability gates", async ({
        absent,
        skillCount,
        workflowCount,
        toolCount,
        resourceCount,
    }) => {
        await skill("review", "Review instructions.")
        await workflow("verify", "Verify steps.")
        const configured = agent(
            "skills: [review]\nworkflows: [verify]\nmcp: [{server: docs@alpha, tools: [read], resources: [repo://policy]}]",
        )
        const selected = await resolveSubagentCapabilitySelection(
            config,
            configured,
            "Review",
            ALL_TOOLS.filter((tool) => tool !== absent),
            PromptProfile.Standard,
        )
        expect(selected.skills).toHaveLength(skillCount)
        expect(selected.workflows).toHaveLength(workflowCount)
        expect(selected.mcpServers.flatMap((entry) => entry.tools ?? [])).toHaveLength(toolCount)
        expect(selected.mcpServers.flatMap((entry) => entry.resources ?? [])).toHaveLength(resourceCount)
        expect(configured.skills).toEqual(["review"])
        expect(configured.workflows).toEqual(["verify"])
        const restored = await resolveSubagentCapabilitySelection(config, configured, "Review", ALL_TOOLS, PromptProfile.Standard)
        expect(restored.skills).toHaveLength(1)
        expect(restored.workflows).toHaveLength(1)
        expect(restored.capabilities.mcp).toHaveLength(1)
    })

    it("does not enlarge Lite loader/execution authority even for mandatory remote items", async () => {
        await rule("policy.md", "Policy without a loader.")
        remote.remoteGlobalSkills = [
            remoteEntry("required", "---\nname: required\ndescription: Required skill\n---\nRequired body.", true),
        ]
        remote.remoteGlobalWorkflows = [
            remoteEntry("required", "---\ndescription: Required workflow\n---\nRequired steps.", true),
        ]
        const selected = await resolveSubagentCapabilitySelection(
            config,
            agent(
                "rules: [{scope: workspace, path: policy.md}]\nmcp: [{server: docs@alpha, tools: [read], resources: [repo://policy]}]",
            ),
            "Review",
            ALL_TOOLS,
            PromptProfile.Lite,
        )
        expect(selected.skills).toEqual([])
        expect(selected.workflows).toEqual([])
        expect(selected.remoteSkillEntries).toEqual([])
        expect(selected.mcpServers).toEqual([])
        expect(selected.capabilities).toEqual({ skills: [], workflows: [], mcp: [], subagents: [] })
        expect(selected.ruleInstructions.localClineRulesFileInstructions).toContain("Policy without a loader.")
    })

    it("captures child intent and enterprise entries before asynchronous discovery yields", async () => {
        await rule("policy.md", "Initial child policy.")
        await skill("review", "Initial review instructions.")
        remote.remoteGlobalSkills = [
            remoteEntry(
                "remote-review",
                "---\nname: remote-review\ndescription: Enterprise review\n---\nInitial enterprise instructions.",
            ),
        ]
        const originalDiscover = skillDiscovery.discoverSkills
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        vi.spyOn(skillDiscovery, "discoverSkills").mockImplementation(async (...args) => {
            await gate
            return originalDiscover(...args)
        })
        const configured = agent("rules: [{scope: workspace, path: policy.md}]\nskills: [review, remote-review]")
        const pending = resolveSubagentCapabilitySelection(config, configured, "Review", ALL_TOOLS, PromptProfile.Standard)
        configured.rules![0].path = "a-later-selection.md"
        configured.skills!.length = 0
        remote.remoteGlobalSkills[0].contents = "A later enterprise edit."
        release()
        const selected = await pending
        expect(selected.skills.map((entry) => entry.name).sort()).toEqual(["remote-review", "review"])
        expect(selected.ruleInstructions.localClineRulesFileInstructions).toContain("Initial child policy.")
        expect((await getSkillContent("remote-review", selected.skills, selected.remoteSkillEntries))?.instructions).toBe(
            "Initial enterprise instructions.",
        )
        expect(Object.isFrozen(configured.rules)).toBe(false)
    })

    it("freezes rule bodies and selections for this run, leaving changed files for the next run", async () => {
        const file = await rule("policy.md", "First policy body.")
        const configured = agent("rules: [{scope: workspace, path: policy.md}]")
        const selected = await resolveSubagentCapabilitySelection(config, configured, "Review", [], PromptProfile.Standard)
        await fs.writeFile(file, "Second policy body.", "utf8")
        configured.rules!.length = 0
        expect(selected.ruleInstructions.localClineRulesFileInstructions).toContain("First policy body.")
        expect(Object.isFrozen(selected.ruleInstructions)).toBe(true)
        expect(Reflect.set(selected.capabilityToggles.localClineRulesToggles, file, false)).toBe(false)
        const nextRun = await resolveSubagentCapabilitySelection(
            config,
            agent("rules: [{scope: workspace, path: policy.md}]"),
            "Review",
            [],
            PromptProfile.Standard,
        )
        expect(nextRun.ruleInstructions.localClineRulesFileInstructions).toContain("Second policy body.")
    })
})
