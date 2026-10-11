import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog, type InputSemanticDescriptor } from "@shared/input-semantics/catalog"
import type { McpServer } from "@shared/mcp"
import { getBuiltInSlashCommands } from "@shared/slashCommands"
import { describe, expect, it } from "vitest"
import {
    getAvailableSlashCommands,
    getMatchingSlashCommands,
    getMcpPromptCommands,
    getSkillCommands,
    type SlashCommandSources,
    slashCommandTrigger,
} from "../slash-commands"

/** The pre-discovery catalog: built-ins only. */
const BUILTIN_CATALOG: InputSemanticCatalog = { revision: 0, descriptors: BUILTIN_INPUT_SEMANTICS }

/** A discovered catalog that admits the given dynamic command triggers. */
function catalogAdmitting(...triggers: string[]): InputSemanticCatalog {
    const dynamic: InputSemanticDescriptor[] = triggers.map((trigger) => ({
        id: `command.test.${trigger}`,
        kind: "command",
        trigger,
        payload: "text",
        composition: "combinable",
        lifecycle: "turn",
        dynamic: true,
    }))
    return { revision: 1, descriptors: [...BUILTIN_INPUT_SEMANTICS, ...dynamic] }
}

/** The commands the menu shows for a query, as the composer computes them. */
function menu(query: string, sources: SlashCommandSources, catalog: InputSemanticCatalog) {
    return getMatchingSlashCommands(query, getAvailableSlashCommands(sources, catalog)).map((entry) => entry.command)
}

// Helper to create a mock MCP server
function createMockMcpServer(overrides: Partial<McpServer> = {}): McpServer {
    return {
        name: "test-server",
        status: "connected",
        config: "{}",
        prompts: [],
        tools: [],
        resources: [],
        resourceTemplates: [],
        ...overrides,
    }
}

describe("slash-commands", () => {
    describe("built-in command visibility", () => {
        it("shows the VS Code-only command above the fold without changing the default selection", () => {
            const result = menu("", {}, BUILTIN_CATALOG)

            expect(result.slice(0, 2).map((command) => command.name)).toEqual(["newtask", "explain-changes"])
        })

        it("matches the VS Code-only command by prefix", () => {
            const result = menu("explain", {}, BUILTIN_CATALOG)

            expect(result.map((command) => command.name)).toEqual(["explain-changes"])
        })

        it("does not expose VS Code-only commands on standalone", () => {
            const result = getBuiltInSlashCommands("standalone")

            expect(result.map((command) => command.name)).not.toContain("explain-changes")
        })
    })

    describe("getMcpPromptCommands", () => {
        it("should return empty array when no servers provided", () => {
            const result = getMcpPromptCommands([])
            expect(result).toEqual([])
        })

        it("should return empty array when servers have no prompts", () => {
            const servers = [createMockMcpServer({ prompts: [] })]
            const result = getMcpPromptCommands(servers)
            expect(result).toEqual([])
        })

        it("should skip disconnected servers", () => {
            const servers = [
                createMockMcpServer({
                    status: "disconnected",
                    prompts: [{ name: "test-prompt", description: "A test prompt" }],
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result).toEqual([])
        })

        it("should skip servers with connecting status", () => {
            const servers = [
                createMockMcpServer({
                    status: "connecting",
                    prompts: [{ name: "test-prompt", description: "A test prompt" }],
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result).toEqual([])
        })

        it("should generate commands for connected servers with prompts", () => {
            const servers = [
                createMockMcpServer({
                    name: "my-server",
                    prompts: [{ name: "summarize", description: "Summarize text" }],
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result).toEqual([
                {
                    name: "my-server:summarize",
                    description: "Summarize text",
                    section: "mcp",
                },
            ])
        })

        it("should use title as fallback description", () => {
            const servers = [
                createMockMcpServer({
                    name: "server",
                    prompts: [{ name: "prompt", title: "My Prompt Title" }],
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result[0].description).toBe("My Prompt Title")
        })

        it("should use default description when no description or title", () => {
            const servers = [
                createMockMcpServer({
                    name: "server",
                    prompts: [{ name: "prompt" }],
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result[0].description).toBe("MCP prompt from server")
        })

        it("should handle multiple prompts from single server", () => {
            const servers = [
                createMockMcpServer({
                    name: "multi-server",
                    prompts: [
                        { name: "prompt1", description: "First prompt" },
                        { name: "prompt2", description: "Second prompt" },
                        { name: "prompt3", description: "Third prompt" },
                    ],
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result).toHaveLength(3)
            expect(result.map((c) => c.name)).toEqual(["multi-server:prompt1", "multi-server:prompt2", "multi-server:prompt3"])
        })

        it("should handle multiple servers with prompts", () => {
            const servers = [
                createMockMcpServer({
                    name: "server-a",
                    prompts: [{ name: "promptA", description: "From A" }],
                }),
                createMockMcpServer({
                    name: "server-b",
                    prompts: [{ name: "promptB", description: "From B" }],
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result).toHaveLength(2)
            expect(result[0].name).toBe("server-a:promptA")
            expect(result[1].name).toBe("server-b:promptB")
        })

        it("should skip servers with undefined prompts", () => {
            const servers = [
                createMockMcpServer({
                    name: "server",
                    prompts: undefined,
                }),
            ]
            const result = getMcpPromptCommands(servers)
            expect(result).toEqual([])
        })
    })

    describe("getSkillCommands", () => {
        it("uses host-provided skill metadata instead of toggle paths", () => {
            const togglePath = "C:\\workspace\\.agents\\skills\\folder-name\\SKILL.md"
            const result = getSkillCommands({ [togglePath]: true }, {}, undefined, undefined, [
                { name: "frontmatter-name", description: "Parsed by the host", section: "skill" },
            ])

            expect(result).toEqual([{ name: "frontmatter-name", description: "Parsed by the host", section: "skill" }])
            expect(JSON.stringify(result)).not.toContain(togglePath)
        })

        it("falls back to the skill folder name without exposing SKILL.md paths", () => {
            const togglePath = "C:\\workspace\\.agents\\skills\\folder-name\\SKILL.md"
            const result = getSkillCommands({ [togglePath]: true })

            expect(result).toEqual([{ name: "folder-name", section: "skill" }])
            expect(JSON.stringify(result)).not.toContain("SKILL.md")
        })
    })

    describe("getMatchingSlashCommands with MCP servers", () => {
        const mcpServers = [
            createMockMcpServer({
                name: "test-server",
                prompts: [
                    { name: "summarize", description: "Summarize content" },
                    { name: "translate", description: "Translate text" },
                ],
            }),
        ]

        const catalog = catalogAdmitting("/mcp:test-server:summarize", "/mcp:test-server:translate")

        it("should include MCP commands in results when no query", () => {
            const result = menu("", { mcpServers }, catalog)
            const mcpCommands = result.filter((cmd) => cmd.section === "mcp")
            expect(mcpCommands).toHaveLength(2)
            expect(mcpCommands[0].name).toBe("test-server:summarize")
            expect(mcpCommands[1].name).toBe("test-server:translate")
        })

        it("should filter MCP commands by query prefix", () => {
            const result = menu("test", { mcpServers }, catalog)
            const mcpCommands = result.filter((cmd) => cmd.section === "mcp")
            expect(mcpCommands).toHaveLength(2)
        })

        it("should filter to specific MCP prompt", () => {
            const result = menu("test-server:sum", { mcpServers }, catalog)
            expect(result).toHaveLength(1)
            expect(result[0].name).toBe("test-server:summarize")
        })

        it("should return empty for non-matching MCP query", () => {
            const result = menu("nonexistent", { mcpServers }, catalog)
            expect(result).toHaveLength(0)
        })
    })

    describe("catalog projection", () => {
        const mcpServers = [
            createMockMcpServer({
                name: "test-server",
                prompts: [
                    { name: "summarize", description: "Summarize content" },
                    { name: "translate", description: "Translate text" },
                ],
            }),
        ]

        it("never offers a capability the catalog does not admit", () => {
            const result = menu("", { mcpServers }, catalogAdmitting("/mcp:test-server:summarize"))

            expect(result.filter((cmd) => cmd.section === "mcp").map((cmd) => cmd.name)).toEqual(["test-server:summarize"])
        })

        it("offers no discovered capability before the backend catalog arrives", () => {
            const result = menu("", { mcpServers, availableSkillCommands: [{ name: "lint" }] }, BUILTIN_CATALOG)

            expect(result.every((cmd) => cmd.section === "default")).toBe(true)
        })

        it("keeps every built-in reachable through the trigger the menu inserts", () => {
            const builtIns = menu("", {}, BUILTIN_CATALOG)

            expect(builtIns.map((cmd) => cmd.name)).toEqual(getBuiltInSlashCommands("vscode").map((cmd) => cmd.name))
        })

        it("hides a built-in whose descriptor the catalog withdrew", () => {
            const withoutCompact: InputSemanticCatalog = {
                revision: 2,
                descriptors: BUILTIN_INPUT_SEMANTICS.filter((descriptor) => descriptor.id !== "command.compact"),
            }

            const names = menu("", {}, withoutCompact).map((cmd) => cmd.name)

            expect(names).not.toContain("compact")
            expect(names).not.toContain("smol")
            expect(names).toContain("newtask")
        })

        it("builds the inserted trigger from the section namespace", () => {
            expect(slashCommandTrigger({ name: "newtask", section: "default" })).toBe("/cmd:newtask")
            expect(slashCommandTrigger({ name: "review", section: "workflow" })).toBe("/workflow:review")
            expect(slashCommandTrigger({ name: "lint", section: "skill" })).toBe("/skills:lint")
            expect(slashCommandTrigger({ name: "s:p", section: "mcp" })).toBe("/mcp:s:p")
            expect(slashCommandTrigger({ name: "plain" })).toBe("/plain")
        })
    })

    describe("menu entries", () => {
        it("binds each row to the catalog identity its trigger resolves to", () => {
            const entries = getAvailableSlashCommands(
                { availableSkillCommands: [{ name: "lint" }] },
                catalogAdmitting("/skills:lint"),
            )

            expect(entries.find((entry) => entry.trigger === "/cmd:newtask")?.commandId).toBe("command.new_task")
            expect(entries.find((entry) => entry.trigger === "/cmd:smol")?.commandId).toBe("command.compact")
            expect(entries.find((entry) => entry.trigger === "/skills:lint")).toMatchObject({
                commandId: "command.test./skills:lint",
                section: "skill",
            })
        })

        it("lists a command that several sources report only once", () => {
            const entries = getAvailableSlashCommands(
                {
                    localWorkflowToggles: { "/ws/.agents/workflows/release.md": true },
                    remoteWorkflows: [{ name: "release", contents: "", alwaysEnabled: true }],
                    remoteWorkflowToggles: {},
                },
                catalogAdmitting("/workflow:release"),
            )

            expect(entries.filter((entry) => entry.trigger === "/workflow:release")).toHaveLength(1)
        })

        it("orders rows by section, so the rendered list and keyboard navigation agree", () => {
            const entries = getAvailableSlashCommands(
                {
                    mcpServers: [createMockMcpServer({ prompts: [{ name: "p" }] })],
                    availableSkillCommands: [{ name: "lint" }],
                    localWorkflowToggles: { "/ws/.agents/workflows/release.md": true },
                },
                catalogAdmitting("/mcp:test-server:p", "/skills:lint", "/workflow:release"),
            )
            const sections = entries.map((entry) => entry.section)

            expect(sections.indexOf("workflow")).toBeGreaterThan(sections.lastIndexOf("default"))
            expect(sections.indexOf("skill")).toBeGreaterThan(sections.lastIndexOf("workflow"))
            expect(sections.indexOf("mcp")).toBeGreaterThan(sections.lastIndexOf("skill"))
        })

        it("matches a namespaced query as well as a bare name", () => {
            const entries = getAvailableSlashCommands(
                { availableSkillCommands: [{ name: "lint" }] },
                catalogAdmitting("/skills:lint"),
            )

            expect(getMatchingSlashCommands("li", entries).map((entry) => entry.trigger)).toEqual(["/skills:lint"])
            expect(getMatchingSlashCommands("skills:li", entries).map((entry) => entry.trigger)).toEqual(["/skills:lint"])
            expect(getMatchingSlashCommands("cmd:new", entries).map((entry) => entry.trigger)).toEqual([
                "/cmd:newtask",
                "/cmd:newrule",
            ])
        })
    })
})
