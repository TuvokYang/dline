import type { ApiProviderInfo } from "@core/api"
import type { McpPromptResponse } from "@shared/mcp"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { expect } from "chai"
import { vi } from "vitest"
import { formatMcpPromptResponse, hasManualCompactionCommand, McpPromptFetcher, parseSlashCommands } from "../index"

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

describe("slash-commands", () => {
	describe("hasManualCompactionCommand", () => {
		it("detects built-in manual compaction commands in user-content tags", () => {
			expect(hasManualCompactionCommand("<task>/compact Keep unresolved failures.</task>")).to.equal(true)
			expect(hasManualCompactionCommand("<feedback>Please /smol before continuing.</feedback>")).to.equal(true)
			expect(hasManualCompactionCommand("<user_message>/cmd:compact Preserve the latest request.</user_message>")).to.equal(
				true,
			)
		})

		it("does not mistake unrelated slash text for a manual compaction command", () => {
			expect(hasManualCompactionCommand("<task>Read https://example.com/compact first.</task>")).to.equal(false)
			expect(hasManualCompactionCommand("<task>/newtask then /compact</task>")).to.equal(false)
			expect(hasManualCompactionCommand("plain /compact text outside a user-content tag")).to.equal(false)
		})

		it("parses isolated user text only when the caller marks the boundary as trusted", async () => {
			const result = await parseSlashCommands(
				"/cmd:compact Preserve the active task.",
				{},
				{},
				"test-ulid",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ trustedUserText: true },
			)

			expect(result.processedText.trim()).to.equal("Preserve the active task.")
			expect(result.explicitInstructions).to.deep.equal([
				{
					type: "summarize_task",
					source: "manual_compact_command",
					targetTool: "summarize_task",
				},
			])
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

	describe("parseSlashCommands profile resolution", () => {
		it("selects the Lite deep-planning contract for a context window below 64K", async () => {
			const result = await parseSlashCommands(
				"<task>/deep-planning</task>",
				{},
				{},
				"test-ulid",
				undefined,
				false,
				createProviderInfo(63_999),
			)

			expect(result.processedText).to.include("This process has four distinct steps")
			expect(result.processedText).to.not.include("This process has five distinct steps")
		})

		it("selects Native deep-planning at the 64K boundary", async () => {
			const result = await parseSlashCommands(
				"<task>/deep-planning</task>",
				{},
				{},
				"test-ulid",
				undefined,
				false,
				createProviderInfo(64_000),
			)

			expect(result.processedText).to.include("This process has five distinct steps")
		})

		it("uses Native when provider info is absent", async () => {
			const result = await parseSlashCommands("<task>/deep-planning</task>", {}, {}, "test-ulid")

			expect(result.processedText).to.include("This process has five distinct steps")
		})
	})

	describe("parseSlashCommands explicit instruction injection", () => {
		const cases = [
			["newtask", "new_task"],
			["newrule", "new_rule"],
			["reportbug", "report_bug"],
		] as const

		it.each([
			["deep-planning", "new_task"],
			["explain-changes", "generate_explanation"],
		] as const)("injects the multi-turn /%s XML instruction", async (command, finalTool) => {
			const result = await parseSlashCommands(
				`<task>/${command}</task>`,
				{},
				{},
				"test-ulid",
				undefined,
				true,
				createProviderInfo(128_000, "gpt-5"),
			)

			expect(result.processedText).to.include(`<${finalTool}>`)
			expect(result.processedText).to.not.include("request-scoped native")
			expect(result).to.not.have.property("requestToolIds")
		})

		for (const [command, toolName] of cases) {
			it(`keeps /${command} as explicit XML instructions with native tool calling enabled`, async () => {
				const result = await parseSlashCommands(
					`<task>/${command}</task>`,
					{},
					{},
					"test-ulid",
					undefined,
					true,
					createProviderInfo(128_000, "gpt-5"),
				)

				expect(result.processedText).to.include(`<${toolName}>`)
				expect(result.processedText).to.include(`</${toolName}>`)
				expect(result.processedText).to.not.include("instruction_id")
				expect(result.processedText).to.not.include("request-scoped native")
				expect(result).to.not.have.property("requestToolIds")
			})
		}

		for (const [command, toolName] of cases) {
			it(`injects a complete XML format for /${command}`, async () => {
				const result = await parseSlashCommands(`<task>/${command}</task>`, {}, {}, "test-ulid")

				expect(result.processedText).to.include(`<${toolName}>`)
				expect(result.processedText).to.include(`</${toolName}>`)
				expect(result.processedText).to.not.include("request-scoped native")
			})
		}

		it("keeps manual compaction guidance independent from focus-chain prompt generation", async () => {
			const withoutFocus = await parseSlashCommands("<task>/compact Keep failures.</task>", {}, {}, "test-ulid", {
				enabled: false,
			})
			const withFocus = await parseSlashCommands("<task>/compact Keep failures.</task>", {}, {}, "test-ulid", {
				enabled: true,
			})

			expect(withoutFocus.processedText).to.equal("<task> Keep failures.</task>")
			expect(withFocus.processedText).to.equal(withoutFocus.processedText)
		})

		it("preserves user feedback written after /compact", async () => {
			const result = await parseSlashCommands(
				"<task>/compact Keep command decisions and unresolved failures.</task>",
				{},
				{},
				"test-ulid",
			)

			expect(result.processedText).to.equal("<task> Keep command decisions and unresolved failures.</task>")
			expect(result.processedText).to.not.include("<summarize_task>")
			expect(result.processedText).to.not.include("instruction_id")
			expect(result.explicitInstructions).to.deep.equal([
				{
					type: "summarize_task",
					source: "manual_compact_command",
					targetTool: "summarize_task",
				},
			])
			expect(result.processedText).to.include("Keep command decisions and unresolved failures.")
			expect(result.processedText).to.not.include("/compact")
		})

		it("keeps compact command removal stable for Lite providers", async () => {
			const result = await parseSlashCommands(
				"<task>/compact</task>",
				{},
				{},
				"test-ulid",
				{ enabled: true },
				true,
				createProviderInfo(63_999),
			)

			expect(result.processedText).to.equal("<task></task>")
		})
	})

	describe("parseSlashCommands MCP handling", () => {
		const enabledMcpContext = (serverName: string) => ({
			cwd: "",
			capabilityToggles: createTaskCapabilityToggles({ mcpServers: { [serverName]: true } }),
			remoteSkills: [],
			remoteWorkflows: [],
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

		it("should process MCP prompt command in task tag", async () => {
			const text = "<task>/mcp:test-server:greet</task>"
			const result = await parseSlashCommands(
				text,
				{},
				{},
				"test-ulid",
				undefined,
				false,
				undefined,
				mockMcpPromptFetcher,
				enabledMcpContext("test-server"),
			)

			expect(result.processedText).to.include('<mcp_prompt server="test-server" prompt="greet">')
			expect(result.processedText).to.include("Hello from MCP!")
			expect(result.needsClinerulesFileCheck).to.equal(false)
		})

		it("should process MCP prompt with additional text", async () => {
			const text = "<task>/mcp:test-server:greet Please expand on this</task>"
			const result = await parseSlashCommands(
				text,
				{},
				{},
				"test-ulid",
				undefined,
				false,
				undefined,
				mockMcpPromptFetcher,
				enabledMcpContext("test-server"),
			)

			expect(result.processedText).to.include('<mcp_prompt server="test-server" prompt="greet">')
			expect(result.processedText).to.include("Please expand on this")
		})

		it("does not fetch an MCP prompt disabled in the current task", async () => {
			let fetchCount = 0
			const fetcher: McpPromptFetcher = async () => {
				fetchCount++
				return {
					messages: [{ role: "user", content: { type: "text", text: "Must stay hidden" } }],
				}
			}
			const text = "<task>/mcp:test-server:greet</task>"
			const result = await Reflect.apply(parseSlashCommands, undefined, [
				text,
				{},
				{},
				"test-ulid",
				undefined,
				false,
				undefined,
				fetcher,
				{
					cwd: "",
					capabilityToggles: createTaskCapabilityToggles({ mcpServers: { "test-server": false } }),
				},
			])

			expect(fetchCount).to.equal(0)
			expect(result.processedText).to.equal(text)
		})

		it("does not fetch an MCP prompt absent from the current task snapshot", async () => {
			const fetcher = vi.fn(mockMcpPromptFetcher)
			const text = "<task>/mcp:test-server:greet</task>"
			const result = await parseSlashCommands(text, {}, {}, "test-ulid", undefined, false, undefined, fetcher, {
				cwd: "",
				capabilityToggles: createTaskCapabilityToggles({ mcpServers: {} }),
				remoteSkills: [],
				remoteWorkflows: [],
			})

			expect(fetcher.mock.calls).to.have.length(0)
			expect(result.processedText).to.equal(text)
		})

		it("should handle MCP prompt with colons in prompt name", async () => {
			const fetcherWithColons: McpPromptFetcher = async (serverName, promptName) => {
				if (serverName === "server" && promptName === "prompt:with:colons") {
					return {
						messages: [{ role: "user", content: { type: "text", text: "Colon prompt" } }],
					}
				}
				return null
			}

			const text = "<task>/mcp:server:prompt:with:colons</task>"
			const result = await parseSlashCommands(
				text,
				{},
				{},
				"test-ulid",
				undefined,
				false,
				undefined,
				fetcherWithColons,
				enabledMcpContext("server"),
			)

			expect(result.processedText).to.include('prompt="prompt:with:colons"')
			expect(result.processedText).to.include("Colon prompt")
		})

		// Note: Tests for "unknown MCP server", "no fetcher", and "fetcher errors"
		// are skipped because they require StateManager initialization when falling
		// through to workflow checking. The core MCP functionality is covered above.
	})

	describe("parseSlashCommands task Skill scope", () => {
		it("injects enabled remote Skill instructions exactly once without a load_skill call", async () => {
			const result = await parseSlashCommands(
				"<task>/skills:reviewer Check this change.</task>",
				{},
				{},
				"test-ulid",
				undefined,
				true,
				createProviderInfo(128_000, "gpt-5"),
				undefined,
				{
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
			)

			expect(result.processedText).to.include('<explicit_instructions type="skill" name="reviewer"')
			expect(result.processedText.split("Review carefully.")).to.have.length(2)
			expect(result.processedText).to.include("Check this change.")
			expect(result.processedText).to.not.include("/skills:reviewer")
			expect(result.processedText).to.not.include("load_skill")
			expect(result).to.not.have.property("requestToolIds")
		})
	})

	describe("parseSlashCommands task workflow scope", () => {
		it("injects enabled remote Workflow instructions exactly once without a load_workflow call", async () => {
			const result = await parseSlashCommands(
				"<task>/workflow:review-release</task>",
				{},
				{},
				"test-ulid",
				undefined,
				false,
				undefined,
				undefined,
				{
					cwd: "",
					capabilityToggles: createTaskCapabilityToggles({
						remoteWorkflowToggles: { "review-release": true },
					}),
					remoteSkills: [],
					remoteWorkflows: [
						{
							name: "review-release",
							alwaysEnabled: false,
							contents: "Review the release marker.",
						},
					],
				},
			)

			expect(result.processedText).to.include('<explicit_instructions type="workflow" name="review-release"')
			expect(result.processedText.split("Review the release marker.")).to.have.length(2)
			expect(result.processedText).to.not.include("load_workflow")
			expect(result).to.not.have.property("requestToolIds")
		})

		it("does not inject a remote workflow disabled in the current task context", async () => {
			const text = "<task>/workflow:review-release</task>"
			const result = await parseSlashCommands(text, {}, {}, "test-ulid", undefined, false, undefined, undefined, {
				cwd: "",
				capabilityToggles: createTaskCapabilityToggles({
					remoteWorkflowToggles: { "review-release": false },
				}),
				remoteSkills: [],
				remoteWorkflows: [
					{
						name: "review-release",
						alwaysEnabled: false,
						contents: "Must stay hidden.",
					},
				],
			})

			expect(result.processedText).to.equal(text)
		})
	})
})
