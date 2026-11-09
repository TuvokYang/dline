import { parseAssistantMessage } from "@core/assistant-message"
import type { McpServer } from "@shared/mcp"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { RuntimePromptGenerator } from "../../generators/RuntimePromptGenerator"
import { SystemPromptGenerator } from "../../generators/SystemPromptGenerator"
import { getPrompt } from "../../i18n"
import { englishTemplateStore } from "../../i18n/en"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../../system-prompt/context"
import type { PromptEnv } from "../../template/types"
import {
    renderCapabilitiesForContext,
    renderCapabilitiesSection,
    renderCapabilityGroups,
    renderCapabilityGroupsForContext,
} from "../CapabilitiesSection"
import type { CapabilitiesSnapshot, McpResourceCapabilityEntry } from "../types"

const EMPTY: CapabilitiesSnapshot = { mcp: [], skills: [], workflows: [], subagents: [] }
const RESOURCES: readonly McpResourceCapabilityEntry[] = Object.freeze(
    [
        {
            server: "docs",
            uri: "repository://instructions?revision=One%2FTwo#policy",
            name: "instructions",
            description: "Primary repository policy",
        },
        {
            server: "docs-alias",
            uri: "repository://instructions?revision=One%2FTwo#policy",
            name: "instructions",
            description: "Other server policy",
        },
        {
            server: "docs",
            uri: "repository://instructions?revision=one%2ftwo#policy",
            name: "instructions",
            description: "Different exact URI",
        },
    ].map((entry) => Object.freeze(entry)),
)
const RESOURCE_ONLY: CapabilitiesSnapshot = Object.freeze({ ...EMPTY, mcpResources: RESOURCES })
const MIXED: CapabilitiesSnapshot = {
    ...RESOURCE_ONLY,
    mcp: [{ server: "docs", name: "docs.search", description: "Search docs" }],
    skills: [{ name: "review", description: "Review changes" }],
    workflows: [{ name: "release", description: "Ship a version" }],
    subagents: [{ name: "research", description: "Investigate a question" }],
}

interface ResourceServer {
    server: string
    count: number
    resources: Array<{ uri: string; name: string; description: string }>
}

/** Read the catalog hierarchy rather than matching its explanatory prose. */
function readResourceServers(text: string): ResourceServer[] {
    const servers: ResourceServer[] = []
    for (const line of text.split("\n")) {
        const server = /^- Server `([^`]+)` \(resources: (\d+)\):$/.exec(line)
        if (server) {
            servers.push({ server: server[1], count: Number(server[2]), resources: [] })
            continue
        }
        const resource = /^ {2}- `([^`]+)` \(`([^`]+)`\): (.*)$/.exec(line)
        if (resource) {
            const owner = servers.at(-1)
            if (!owner) throw new Error("Resource entry has no owning server")
            owner.resources.push({ uri: resource[1], name: resource[2], description: resource[3] })
        }
    }
    return servers
}

function readToolNames(text: string): string[] {
    return [...text.matchAll(/^ {2}- `([^`]+)`: /gm)].map((match) => match[1])
}

const EXPECTED_SERVERS: ResourceServer[] = [
    {
        server: "docs",
        count: 2,
        resources: [
            {
                uri: "repository://instructions?revision=One%2FTwo#policy",
                name: "instructions",
                description: "Primary repository policy",
            },
            {
                uri: "repository://instructions?revision=one%2ftwo#policy",
                name: "instructions",
                description: "Different exact URI",
            },
        ],
    },
    {
        server: "docs-alias",
        count: 1,
        resources: [
            {
                uri: "repository://instructions?revision=One%2FTwo#policy",
                name: "instructions",
                description: "Other server policy",
            },
        ],
    },
]

const STANDARD_CONTEXT = { profile: PromptProfile.Standard, subagentsEnabled: true } as const
const TOOL_GATES = [
    { disableTools: [], toolsVisible: true, resourcesVisible: true },
    { disableTools: [DlineDefaultTool.LOAD_MCP], toolsVisible: false, resourcesVisible: true },
    { disableTools: [DlineDefaultTool.MCP_USE], toolsVisible: false, resourcesVisible: true },
    { disableTools: [DlineDefaultTool.MCP_ACCESS], toolsVisible: true, resourcesVisible: false },
    { disableTools: [DlineDefaultTool.LOAD_MCP, DlineDefaultTool.MCP_USE], toolsVisible: false, resourcesVisible: true },
    { disableTools: [DlineDefaultTool.LOAD_MCP, DlineDefaultTool.MCP_ACCESS], toolsVisible: false, resourcesVisible: false },
    { disableTools: [DlineDefaultTool.MCP_USE, DlineDefaultTool.MCP_ACCESS], toolsVisible: false, resourcesVisible: false },
    {
        disableTools: [DlineDefaultTool.LOAD_MCP, DlineDefaultTool.MCP_USE, DlineDefaultTool.MCP_ACCESS],
        toolsVisible: false,
        resourcesVisible: false,
    },
]

describe("MCP resource catalog", () => {
    it.each(
        TOOL_GATES.filter((gate) => gate.resourcesVisible),
    )("advertises resource-only selections with disabled tools $disableTools", ({ disableTools }) => {
        const groups = renderCapabilityGroupsForContext(RESOURCE_ONLY, { ...STANDARD_CONTEXT, disableTools })

        expect(groups.map((group) => group.source)).toEqual(["mcp"])
        expect(readResourceServers(groups[0].text)).toEqual(EXPECTED_SERVERS)
        expect(readToolNames(groups[0].text)).toEqual([])
        // Only resource invocation is advertised; resource identities are not load_mcp names.
        expect([...groups[0].text.matchAll(/`([^`]+)`/g)].slice(0, 3).map((match) => match[1])).toEqual([
            DlineDefaultTool.MCP_ACCESS,
            "server_name",
            "uri",
        ])
        expect(groups[0].text.match(/`(?:load_mcp|use_mcp_tool)`/g)).toBeNull()
    })

    it.each(TOOL_GATES)("gates MCP tools and resources independently with disabled tools $disableTools", ({
        disableTools,
        toolsVisible,
        resourcesVisible,
    }) => {
        const groups = renderCapabilityGroupsForContext(MIXED, { ...STANDARD_CONTEXT, disableTools })
        const mcp = groups.find((group) => group.source === "mcp")?.text ?? ""

        expect(groups.map((group) => group.source)).toEqual([
            ...(toolsVisible || resourcesVisible ? ["mcp"] : []),
            "skills",
            "workflows",
            "subagents",
        ])
        expect(readToolNames(mcp)).toEqual(toolsVisible ? ["docs.search"] : [])
        expect(readResourceServers(mcp)).toEqual(resourcesVisible ? EXPECTED_SERVERS : [])
    })

    it("keeps resources after MCP tools inside the original MCP group and preserves group order", () => {
        const section = renderCapabilitiesForContext(MIXED, STANDARD_CONTEXT)
        const groups = renderCapabilityGroupsForContext(MIXED, STANDARD_CONTEXT)

        expect(groups.map((group) => group.source)).toEqual(["mcp", "skills", "workflows", "subagents"])
        expect(section.split("\n").filter((line) => /^#{2,3} /.test(line))).toEqual([
            "## MCP",
            "### Resources",
            "## Skills",
            "## Workflows",
            "## Subagents",
        ])
        expect(groups[0].text.indexOf("  - `docs.search`: ")).toBeLessThan(groups[0].text.indexOf("### Resources"))
        expect(readResourceServers(section)).toEqual(EXPECTED_SERVERS)
        expect(renderCapabilityGroups(MIXED, { exclude: ["mcp"] }).map((group) => group.source)).toEqual([
            "skills",
            "workflows",
            "subagents",
        ])
    })

    it("omits the MCP group when its only resources cannot be accessed", () => {
        expect(
            renderCapabilityGroupsForContext(RESOURCE_ONLY, {
                ...STANDARD_CONTEXT,
                disableTools: [DlineDefaultTool.MCP_ACCESS],
            }),
        ).toEqual([])
    })

    it.each([
        PromptProfile.Standard,
        PromptProfile.Lite,
    ])("preserves the legacy tool catalog byte-for-byte when resources are absent in %s", (profile) => {
        const legacy: CapabilitiesSnapshot = { ...EMPTY, mcp: MIXED.mcp }
        const prefix = profile === PromptProfile.Lite ? "lite" : "standard"
        const expected = [
            getPrompt("capabilityCatalog", "heading"),
            [
                "## MCP",
                getPrompt("mcp", `${prefix}CatalogGuidance`),
                "",
                getPrompt("mcp", `${prefix}CatalogListIntroduction`),
                "- Server `docs` (tools: 1):",
                "  - `docs.search`: Search docs",
            ].join("\n"),
        ].join("\n\n")

        expect(renderCapabilitiesSection(legacy, { profile })).toBe(expected)
        expect(renderCapabilitiesSection({ ...legacy, mcpResources: [] }, { profile })).toBe(expected)
        expect(renderCapabilitiesForContext(legacy, { profile })).toBe(expected)
    })

    it("does not expose resources in Lite or change its existing MCP/workflow awareness catalogs", () => {
        const context = {
            profile: PromptProfile.Lite,
            subagentsEnabled: true,
            disableTools: [
                DlineDefaultTool.LOAD_MCP,
                DlineDefaultTool.MCP_USE,
                DlineDefaultTool.MCP_ACCESS,
                DlineDefaultTool.LOAD_WORKFLOW,
            ],
        } as const
        const groups = renderCapabilityGroupsForContext(MIXED, context)

        expect(groups.map((group) => group.source)).toEqual(["mcp", "workflows"])
        expect(readToolNames(groups[0].text)).toEqual(["docs.search"])
        expect(readResourceServers(groups.map((group) => group.text).join("\n\n"))).toEqual([])
        expect(renderCapabilitiesForContext(MIXED, context)).toBe(
            renderCapabilitiesForContext({ ...MIXED, mcpResources: [] }, context),
        )
        expect(renderCapabilityGroupsForContext(RESOURCE_ONLY, { profile: PromptProfile.Lite })).toEqual([])
        expect(renderCapabilitiesSection(MIXED, { profile: PromptProfile.Lite })).toBe(
            renderCapabilitiesSection({ ...MIXED, mcpResources: [] }, { profile: PromptProfile.Lite }),
        )
    })

    it("bounds resource descriptions without truncating exact URIs and escapes inline identities", () => {
        const uri = `repository://instructions?revision=One%2FTwo#${"z".repeat(300)}`
        const section = renderCapabilitiesSection({
            ...EMPTY,
            mcpResources: [{ server: "docs`east", uri, name: "guide`v1", description: `First\n\tline ${"x".repeat(400)}` }],
        })

        expect(section.split("\n").filter((line) => /^\s*- /.test(line))).toEqual([
            "- Server `docs\\`east` (resources: 1):",
            `  - \`${uri}\` (\`guide\\\`v1\`): First line ${"x".repeat(229)}`,
        ])
    })
})

describe("MCP resource prompt contracts", () => {
    const cases: Array<{ template: string; env: PromptEnv; keys: string[]; lastLine: string }> = [
        {
            template: "mcp.resourceCatalog",
            env: { ENTRIES: "resource-rows" },
            keys: ["ENTRIES"],
            lastLine: "resource-rows",
        },
        {
            template: "mcp.resourceServerEntry",
            env: { NAME: "docs", COUNT: "2" },
            keys: ["NAME", "COUNT"],
            lastLine: "- Server `docs` (resources: 2):",
        },
        {
            template: "mcp.resourceEntry",
            env: { URI: "repository://$&/$1?path=%2F&owner=user@example.org", NAME: "guide", DESCRIPTION: "Policy" },
            keys: ["URI", "NAME", "DESCRIPTION"],
            lastLine: "- `repository://$&/$1?path=%2F&owner=user@example.org` (`guide`): Policy",
        },
    ]
    it.each(cases)("registers and resolves exactly the runtime slots of $template", ({ template, env, keys, lastLine }) => {
        const generator = new RuntimePromptGenerator(englishTemplateStore)
        const output = generator.generate(template, env)

        expect(output.text.split("\n").at(-1)).toBe(lastLine)
        expect(output.warnings).toEqual([])
        expect(output.trace.map((trace) => trace.key)).toEqual(keys)
        expect(generator.generate(template, {}).warnings.map(({ key, rule }) => ({ key, rule }))).toEqual(
            keys.map((key) => ({ key, rule: { stages: ["runtime"], required: true } })),
        )
    })
})

const SYSTEM_CONTEXT: SystemPromptContext = {
    promptProfile: PromptProfile.Standard,
    cwd: "/workspace/project",
    ide: "Test IDE",
    providerInfo: {
        providerId: "openai",
        model: { id: "resource-catalog", info: { id: "resource-catalog", capabilities: {} } },
        mode: "act",
    },
    focusChainSettings: { enabled: false, remindClineInterval: 0 },
    mcpToolsOnDemand: true,
    isSubagentRun: true,
    isTesting: true,
    disableTools: [DlineDefaultTool.LOAD_MCP, DlineDefaultTool.MCP_USE],
    mcpHub: {
        getServers: (): McpServer[] => [
            {
                name: "docs",
                config: "{}",
                status: "connected",
                tools: [],
                resources: [
                    ...RESOURCES.filter((resource) => resource.server === "docs"),
                    { uri: "repository://parent-only", name: "parent", description: "Not selected" },
                ],
            },
            {
                name: "docs-alias",
                config: "{}",
                status: "connected",
                tools: [],
                resources: RESOURCES.filter((resource) => resource.server === "docs-alias"),
            },
        ],
    },
}

describe("MCP resources in the system prompt pipeline", () => {
    it.each([false, true])("renders selected resources with native tools = %s and no loader", async (enableNativeToolCalls) => {
        const generated = await new SystemPromptGenerator().generate({
            ...SYSTEM_CONTEXT,
            capabilities: RESOURCE_ONLY,
            enableNativeToolCalls,
        })
        const servers = readResourceServers(generated.systemPrompt)

        expect(servers).toEqual(EXPECTED_SERVERS)
        expect(generated.warnings).toEqual([])
        expect(generated.systemPrompt).not.toContain("repository://parent-only")
        expect(generated.systemPrompt).not.toMatch(/@(?:ENTRIES|URI|NAME|DESCRIPTION|COUNT)@/)
        if (enableNativeToolCalls) {
            const functions = (generated.tools ?? []).flatMap((tool) => ("function" in tool ? [tool.function] : []))
            const mcpIds = new Set<string>([DlineDefaultTool.MCP_ACCESS, DlineDefaultTool.LOAD_MCP, DlineDefaultTool.MCP_USE])
            expect(functions.map((tool) => tool.name).filter((name) => mcpIds.has(name))).toEqual([DlineDefaultTool.MCP_ACCESS])
            expect(functions.find((tool) => tool.name === DlineDefaultTool.MCP_ACCESS)?.parameters).toEqual({
                type: "object",
                properties: {
                    server_name: { type: "string", description: getPrompt("accessMcpResource", "serverNameInstruction") },
                    uri: { type: "string", description: getPrompt("accessMcpResource", "uriInstruction") },
                },
                required: ["server_name", "uri"],
                additionalProperties: false,
            })
            const withoutResources = await new SystemPromptGenerator().generate({
                ...SYSTEM_CONTEXT,
                capabilities: EMPTY,
                enableNativeToolCalls: true,
            })
            expect(generated.tools).toEqual(withoutResources.tools)
        } else {
            expect(generated.tools).toBeUndefined()
            const example = generated.systemPrompt.match(/<access_mcp_resource>[\s\S]*?<\/access_mcp_resource>/)?.[0]
            if (!example) throw new Error("The resource access tool must expose an XML invocation example")
            for (const server of servers) {
                for (const resource of server.resources) {
                    const call = example
                        .replace("<server_name></server_name>", `<server_name>${server.server}</server_name>`)
                        .replace("<uri></uri>", `<uri>${resource.uri}</uri>`)
                    const blocks = parseAssistantMessage(call, {
                        getOrCreateTsForBlock: () => 1,
                        getOrCreateToolIdentityForBlock: (key) => ({ function_id: `function-${key}`, dline_tid: `trace-${key}` }),
                    })
                    expect(blocks).toEqual([
                        expect.objectContaining({
                            type: "tool_use",
                            name: DlineDefaultTool.MCP_ACCESS,
                            partial: false,
                            params: { server_name: server.server, uri: resource.uri },
                        }),
                    ])
                }
            }
        }
    })

    it("withholds inaccessible resources without removing the available MCP tool catalog or schemas", async () => {
        const generated = await new SystemPromptGenerator().generate({
            ...SYSTEM_CONTEXT,
            capabilities: { ...RESOURCE_ONLY, mcp: MIXED.mcp },
            disableTools: [DlineDefaultTool.MCP_ACCESS],
            enableNativeToolCalls: true,
            mcpHub: {
                getServers: () => [
                    {
                        name: "docs",
                        config: "{}",
                        status: "connected",
                        tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }],
                    },
                ],
            },
        })
        const names = (generated.tools ?? []).flatMap((tool) => ("function" in tool ? [tool.function.name] : []))
        const mcpIds = new Set<string>([DlineDefaultTool.MCP_ACCESS, DlineDefaultTool.LOAD_MCP, DlineDefaultTool.MCP_USE])

        expect(readToolNames(generated.systemPrompt)).toEqual(["docs.search"])
        expect(readResourceServers(generated.systemPrompt)).toEqual([])
        expect(names.filter((name) => mcpIds.has(name))).toEqual([DlineDefaultTool.MCP_USE, DlineDefaultTool.LOAD_MCP])
        expect(generated.warnings).toEqual([])
    })

    it.each([
        PromptProfile.Standard,
        PromptProfile.Lite,
    ])("does not discover resources from the MCP Hub in a %s parent prompt without the optional projection", async (promptProfile) => {
        const generated = await new SystemPromptGenerator().generate({
            ...SYSTEM_CONTEXT,
            promptProfile,
            isSubagentRun: false,
            capabilities: EMPTY,
            enableNativeToolCalls: true,
        })

        expect(readResourceServers(generated.systemPrompt)).toEqual([])
        expect(generated.systemPrompt.match(/repository:\/\/[^\s`]+/g)).toBeNull()
    })

    it("keeps selected resources out of Lite's system and actual tool projection", async () => {
        const generated = await new SystemPromptGenerator().generate({
            ...SYSTEM_CONTEXT,
            promptProfile: PromptProfile.Lite,
            capabilities: RESOURCE_ONLY,
            disableTools: [],
            enableNativeToolCalls: true,
        })
        const names = (generated.tools ?? []).flatMap((tool) => ("function" in tool ? [tool.function.name] : []))

        expect(readResourceServers(generated.systemPrompt)).toEqual([])
        expect(generated.systemPrompt.match(/repository:\/\/[^\s`]+/g)).toBeNull()
        expect(names).not.toContain(DlineDefaultTool.MCP_ACCESS)
        expect(names).not.toContain(DlineDefaultTool.LOAD_MCP)
        expect(names).not.toContain(DlineDefaultTool.MCP_USE)
        expect(names).not.toContain(DlineDefaultTool.LOAD_WORKFLOW)
    })
})
