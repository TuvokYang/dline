import type { ApiProviderInfo } from "@core/api"
import { BUILTIN_INPUT_SEMANTICS, type InputSemanticDescriptor } from "@shared/input-semantics/catalog"
import type { McpPromptResponse } from "@shared/mcp"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { expect } from "chai"
import { vi } from "vitest"
import {
    type BuiltinCommandName,
    expandSlashCommand,
    formatMcpPromptResponse,
    type McpPromptFetcher,
    type SlashCommandExpansion,
    type SlashCommandExpansionContext,
    type SlashCommandTarget,
    slashCommandTargetOf,
} from "../index"

function createProviderInfo(contextWindow?: number, modelId = "test-model"): ApiProviderInfo {
    return {
        providerId: "openai",
        model: {
            id: modelId,
            info: { capabilities: { contextWindow } },
        },
        mode: "act",
    } as ApiProviderInfo
}

const builtin = (name: BuiltinCommandName): SlashCommandTarget => ({ kind: "builtin", name })

function expansionContext(overrides: Partial<SlashCommandExpansionContext> = {}): SlashCommandExpansionContext {
    return { localWorkflowToggles: {}, globalWorkflowToggles: {}, taskIncarnationId: "test-ulid", ...overrides }
}

async function expand(
    target: SlashCommandTarget,
    overrides?: Partial<SlashCommandExpansionContext>,
): Promise<SlashCommandExpansion> {
    const expansion = await expandSlashCommand(target, expansionContext(overrides))
    if (!expansion) throw new Error("expected the command to expand")
    return expansion
}

describe("slash-commands", () => {
    describe("slashCommandTargetOf", () => {
        it("maps every built-in command descriptor to a built-in target by identity", () => {
            const commands = BUILTIN_INPUT_SEMANTICS.filter((descriptor) => descriptor.kind === "command")
            expect(commands.map((descriptor) => slashCommandTargetOf(descriptor)?.kind)).to.deep.equal(
                commands.map(() => "builtin"),
            )
        })

        it("uses the capability a discovered descriptor carries instead of its trigger", () => {
            const descriptor: InputSemanticDescriptor = {
                id: "command.mcp.server.prompt",
                kind: "command",
                trigger: "/mcp:server:prompt:with:colons",
                payload: "text",
                composition: "combinable",
                lifecycle: "turn",
                dynamic: true,
                capability: { namespace: "mcp", server: "server", prompt: "prompt:with:colons" },
            }
            expect(slashCommandTargetOf(descriptor)).to.deep.equal({
                kind: "capability",
                capability: { namespace: "mcp", server: "server", prompt: "prompt:with:colons" },
            })
        })

        it("refuses a descriptor that is not a command Core can expand", () => {
            const mention = BUILTIN_INPUT_SEMANTICS.find((descriptor) => descriptor.kind === "mention")
            expect(mention && slashCommandTargetOf(mention)).to.equal(undefined)
            expect(
                slashCommandTargetOf({
                    id: "command.unknown",
                    kind: "command",
                    trigger: "/unknown",
                    payload: "none",
                    composition: "exclusive",
                    lifecycle: "turn",
                }),
            ).to.equal(undefined)
        })
    })

    describe("built-in expansion", () => {
        it("expands /compact to nothing but its summarize authority", async () => {
            const result = await expand(builtin("compact"))

            expect(result.text).to.equal("")
            expect(result.explicitInstructions).to.deep.equal([
                {
                    type: "summarize_task",
                    source: "manual_compact_command",
                    targetTool: "summarize_task",
                },
            ])
        })

        it("keeps manual compaction independent from focus-chain prompt generation and the provider profile", async () => {
            const withoutFocus = await expand(builtin("compact"), { focusChainSettings: { enabled: false } })
            const withFocus = await expand(builtin("compact"), { focusChainSettings: { enabled: true } })
            const lite = await expand(builtin("compact"), {
                focusChainSettings: { enabled: true },
                enableNativeToolCalls: true,
                providerInfo: createProviderInfo(63_999),
            })

            expect(withFocus.text).to.equal(withoutFocus.text)
            expect(lite.text).to.equal(withoutFocus.text)
        })

        it("asks for a clinerules file check only for /newrule", async () => {
            expect((await expand(builtin("newrule"))).needsClinerulesFileCheck).to.equal(true)
            expect((await expand(builtin("newtask"))).needsClinerulesFileCheck).to.equal(false)
        })
    })

    describe("formatMcpPromptResponse", () => {
        it("should format text message", () => {
            const response: McpPromptResponse = {
                messages: [{ role: "user", content: { type: "text", text: "Hello world" } }],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.equal("[User]\nHello world")
        })

        it("should format assistant message", () => {
            const response: McpPromptResponse = {
                messages: [{ role: "assistant", content: { type: "text", text: "I can help" } }],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.equal("[Assistant]\nI can help")
        })

        it("should include description when provided", () => {
            const response: McpPromptResponse = {
                description: "Test description",
                messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.include("Description: Test description")
            expect(result).to.include("[User]\nHello")
        })

        it("should format multiple messages", () => {
            const response: McpPromptResponse = {
                messages: [
                    { role: "user", content: { type: "text", text: "Question" } },
                    { role: "assistant", content: { type: "text", text: "Answer" } },
                ],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.include("[User]\nQuestion")
            expect(result).to.include("[Assistant]\nAnswer")
        })

        it("should format image content", () => {
            const response: McpPromptResponse = {
                messages: [{ role: "user", content: { type: "image", data: "base64data", mimeType: "image/png" } }],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.equal("[User]\n[Image: image/png]")
        })

        it("should format audio content", () => {
            const response: McpPromptResponse = {
                messages: [{ role: "user", content: { type: "audio", data: "base64data", mimeType: "audio/mp3" } }],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.equal("[User]\n[Audio: audio/mp3]")
        })

        it("should format resource with text", () => {
            const response: McpPromptResponse = {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "resource",
                            resource: { uri: "file:///test.txt", text: "File content" },
                        },
                    },
                ],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.include("[Resource: file:///test.txt]")
            expect(result).to.include("File content")
        })

        it("should format resource without text", () => {
            const response: McpPromptResponse = {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "resource",
                            resource: { uri: "file:///binary.bin" },
                        },
                    },
                ],
            }
            const result = formatMcpPromptResponse(response)
            expect(result).to.equal("[User]\n[Resource: file:///binary.bin]")
        })
    })

    describe("deep-planning profile resolution", () => {
        it("selects the Lite deep-planning contract for a context window below 64K", async () => {
            const result = await expand(builtin("deep-planning"), {
                enableNativeToolCalls: false,
                providerInfo: createProviderInfo(63_999),
            })

            expect(result.text).to.include("This process has four distinct steps")
            expect(result.text).to.not.include("This process has five distinct steps")
        })

        it("selects Native deep-planning at the 64K boundary", async () => {
            const result = await expand(builtin("deep-planning"), {
                enableNativeToolCalls: false,
                providerInfo: createProviderInfo(64_000),
            })

            expect(result.text).to.include("This process has five distinct steps")
        })

        it("uses Native when provider info is absent", async () => {
            const result = await expand(builtin("deep-planning"))

            expect(result.text).to.include("This process has five distinct steps")
        })
    })

    describe("explicit instruction injection", () => {
        const cases = [
            ["newtask", "new_task"],
            ["newrule", "new_rule"],
            ["reportbug", "report_bug"],
        ] as const

        it.each([
            ["deep-planning", "new_task"],
            ["explain-changes", "generate_explanation"],
        ] as const)("injects the multi-turn /%s XML instruction", async (command, finalTool) => {
            const result = await expand(builtin(command), {
                enableNativeToolCalls: true,
                providerInfo: createProviderInfo(128_000, "gpt-5"),
            })

            expect(result.text).to.include(`<${finalTool}>`)
            expect(result.text).to.not.include("request-scoped native")
            expect(result).to.not.have.property("requestToolIds")
        })

        for (const [command, toolName] of cases) {
            it(`keeps /${command} as explicit XML instructions with native tool calling enabled`, async () => {
                const result = await expand(builtin(command), {
                    enableNativeToolCalls: true,
                    providerInfo: createProviderInfo(128_000, "gpt-5"),
                })

                expect(result.text).to.include(`<${toolName}>`)
                expect(result.text).to.include(`</${toolName}>`)
                expect(result.text).to.not.include("instruction_id")
                expect(result.text).to.not.include("request-scoped native")
                expect(result).to.not.have.property("requestToolIds")
            })
        }

        for (const [command, toolName] of cases) {
            it(`injects a complete XML format for /${command}`, async () => {
                const result = await expand(builtin(command))

                expect(result.text).to.include(`<${toolName}>`)
                expect(result.text).to.include(`</${toolName}>`)
                expect(result.text).to.not.include("request-scoped native")
            })
        }
    })

    describe("MCP prompt expansion", () => {
        const enabledMcpContext = (serverName: string) => ({
            cwd: "",
            capabilityToggles: createTaskCapabilityToggles({ mcpServers: { [serverName]: true } }),
            remoteSkills: [],
            remoteWorkflows: [],
        })
        const mcp = (server: string, prompt: string): SlashCommandTarget => ({
            kind: "capability",
            capability: { namespace: "mcp", server, prompt },
        })

        const mockMcpPromptFetcher: McpPromptFetcher = async (serverName, promptName) => {
            if (serverName === "test-server" && promptName === "greet") {
                return {
                    description: "A greeting prompt",
                    messages: [{ role: "user", content: { type: "text", text: "Hello from MCP!" } }],
                }
            }
            return null
        }

        it("expands an enabled MCP prompt", async () => {
            const result = await expand(mcp("test-server", "greet"), {
                mcpPromptFetcher: mockMcpPromptFetcher,
                capabilityContext: enabledMcpContext("test-server"),
            })

            expect(result.text).to.include('<mcp_prompt server="test-server" prompt="greet">')
            expect(result.text).to.include("Hello from MCP!")
            expect(result.needsClinerulesFileCheck).to.equal(false)
        })

        it("does not fetch an MCP prompt disabled in the current task", async () => {
            const fetcher = vi.fn(mockMcpPromptFetcher)
            const result = await expandSlashCommand(
                mcp("test-server", "greet"),
                expansionContext({
                    mcpPromptFetcher: fetcher,
                    capabilityContext: {
                        ...enabledMcpContext("test-server"),
                        capabilityToggles: createTaskCapabilityToggles({ mcpServers: { "test-server": false } }),
                    },
                }),
            )

            expect(fetcher.mock.calls).to.have.length(0)
            expect(result).to.equal(undefined)
        })

        it("does not fetch an MCP prompt absent from the current task snapshot", async () => {
            const fetcher = vi.fn(mockMcpPromptFetcher)
            const result = await expandSlashCommand(
                mcp("test-server", "greet"),
                expansionContext({
                    mcpPromptFetcher: fetcher,
                    capabilityContext: {
                        ...enabledMcpContext("test-server"),
                        capabilityToggles: createTaskCapabilityToggles({ mcpServers: {} }),
                    },
                }),
            )

            expect(fetcher.mock.calls).to.have.length(0)
            expect(result).to.equal(undefined)
        })

        it("reports an unavailable prompt instead of expanding it", async () => {
            const result = await expandSlashCommand(
                mcp("test-server", "missing"),
                expansionContext({ mcpPromptFetcher: mockMcpPromptFetcher, capabilityContext: enabledMcpContext("test-server") }),
            )

            expect(result).to.equal(undefined)
        })

        it("passes a prompt name containing colons through unsplit", async () => {
            const fetcherWithColons: McpPromptFetcher = async (serverName, promptName) =>
                serverName === "server" && promptName === "prompt:with:colons"
                    ? { messages: [{ role: "user", content: { type: "text", text: "Colon prompt" } }] }
                    : null

            const result = await expand(mcp("server", "prompt:with:colons"), {
                mcpPromptFetcher: fetcherWithColons,
                capabilityContext: enabledMcpContext("server"),
            })

            expect(result.text).to.include('prompt="prompt:with:colons"')
            expect(result.text).to.include("Colon prompt")
        })
    })

    describe("task Skill scope", () => {
        it("injects enabled remote Skill instructions exactly once without a load_skill call", async () => {
            const result = await expand(
                { kind: "capability", capability: { namespace: "skill", name: "reviewer" } },
                {
                    enableNativeToolCalls: true,
                    providerInfo: createProviderInfo(128_000, "gpt-5"),
                    capabilityContext: {
                        cwd: "",
                        capabilityToggles: createTaskCapabilityToggles({ remoteSkillsToggles: { reviewer: true } }),
                        remoteSkills: [
                            {
                                name: "reviewer",
                                alwaysEnabled: false,
                                contents: "---\nname: reviewer\ndescription: Review code\n---\nReview carefully.",
                            },
                        ],
                        remoteWorkflows: [],
                    },
                },
            )

            expect(result.text).to.include('<explicit_instructions type="skill" name="reviewer"')
            expect(result.text.split("Review carefully.")).to.have.length(2)
            expect(result.text).to.not.include("/skills:reviewer")
            expect(result.text).to.not.include("load_skill")
            expect(result.explicitInstructions).to.deep.equal([
                { type: "skill", source: "skill_injection", metadata: { name: "reviewer" } },
            ])
        })
    })

    describe("task workflow scope", () => {
        const workflow: SlashCommandTarget = { kind: "capability", capability: { namespace: "workflow", name: "review-release" } }
        const remoteWorkflowContext = (enabled: boolean, contents: string) => ({
            capabilityContext: {
                cwd: "",
                capabilityToggles: createTaskCapabilityToggles({ remoteWorkflowToggles: { "review-release": enabled } }),
                remoteSkills: [],
                remoteWorkflows: [{ name: "review-release", alwaysEnabled: false, contents }],
            },
        })

        it("injects enabled remote Workflow instructions exactly once without a load_workflow call", async () => {
            const result = await expand(workflow, remoteWorkflowContext(true, "Review the release marker."))

            expect(result.text).to.include('<explicit_instructions type="workflow" name="review-release"')
            expect(result.text.split("Review the release marker.")).to.have.length(2)
            expect(result.text).to.not.include("load_workflow")
            expect(result).to.not.have.property("requestToolIds")
        })

        it("does not inject a remote workflow disabled in the current task context", async () => {
            const result = await expandSlashCommand(workflow, expansionContext(remoteWorkflowContext(false, "Must stay hidden.")))

            expect(result).to.equal(undefined)
        })
    })
})
