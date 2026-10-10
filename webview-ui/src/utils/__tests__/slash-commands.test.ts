import type { McpServer } from "@shared/mcp"
import { getBuiltInSlashCommands } from "@shared/slashCommands"
import { describe, expect, it } from "vitest"
import {
    getMatchingSlashCommands,
    getMcpPromptCommands,
    getSkillCommands,
    slashCommandRegex,
    validateSlashCommand,
} from "../slash-commands"

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
            const result = getMatchingSlashCommands("")

            expect(result.slice(0, 2).map((command) => command.name)).toEqual(["newtask", "explain-changes"])
        })

        it("matches the VS Code-only command by prefix", () => {
            const result = getMatchingSlashCommands("explain")

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

        it("should include MCP commands in results when no query", () => {
            const result = getMatchingSlashCommands("", {}, {}, undefined, undefined, mcpServers)
            const mcpCommands = result.filter((cmd) => cmd.section === "mcp")
            expect(mcpCommands).toHaveLength(2)
            expect(mcpCommands[0].name).toBe("test-server:summarize")
            expect(mcpCommands[1].name).toBe("test-server:translate")
        })

        it("should filter MCP commands by query prefix", () => {
            const result = getMatchingSlashCommands("test", {}, {}, undefined, undefined, mcpServers)
            const mcpCommands = result.filter((cmd) => cmd.section === "mcp")
            expect(mcpCommands).toHaveLength(2)
        })

        it("should filter to specific MCP prompt", () => {
            const result = getMatchingSlashCommands("test-server:sum", {}, {}, undefined, undefined, mcpServers)
            expect(result).toHaveLength(1)
            expect(result[0].name).toBe("test-server:summarize")
        })

        it("should return empty for non-matching MCP query", () => {
            const result = getMatchingSlashCommands("nonexistent", {}, {}, undefined, undefined, mcpServers)
            expect(result).toHaveLength(0)
        })
    })

    describe("validateSlashCommand with MCP servers", () => {
        const mcpServers = [
            createMockMcpServer({
                name: "server",
                prompts: [{ name: "prompt", description: "Test" }],
            }),
        ]

        it("should return full for exact MCP command match", () => {
            const result = validateSlashCommand("server:prompt", {}, {}, undefined, undefined, mcpServers)
            expect(result).toBe("full")
        })

        it("should return partial for partial MCP command match", () => {
            const result = validateSlashCommand("server:pro", {}, {}, undefined, undefined, mcpServers)
            expect(result).toBe("partial")
        })

        it("should return partial for server prefix only", () => {
            const result = validateSlashCommand("serv", {}, {}, undefined, undefined, mcpServers)
            expect(result).toBe("partial")
        })

        it("should return null for non-matching MCP command", () => {
            const result = validateSlashCommand("unknown:cmd", {}, {}, undefined, undefined, mcpServers)
            expect(result).toBe(null)
        })
    })

    describe("slashCommandRegex with MCP format", () => {
        it("should match MCP command format with colons", () => {
            const text = "/mcp:server:prompt"
            const match = text.match(slashCommandRegex)
            expect(match).not.toBeNull()
            expect(match?.[2]).toBe("/mcp:server:prompt")
        })

        it("should match MCP command in middle of text", () => {
            const text = "Please run /mcp:server:prompt now"
            const match = text.match(slashCommandRegex)
            expect(match).not.toBeNull()
            expect(match?.[2]).toBe("/mcp:server:prompt")
        })

        it("should not match MCP-like pattern in URL", () => {
            const text = "http://example.com/mcp:test"
            const match = text.match(slashCommandRegex)
            // Should not match because / is not preceded by whitespace or start
            expect(match).toBeNull()
        })
    })
})
