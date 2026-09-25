import { describe, expect, it } from "vitest"
import {
	GPT_IMAGE_1_MODEL_ID,
	GPT_IMAGE_2_MODEL_ID,
	GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID,
} from "../../../../shared/image-generation"
import { ClineDefaultTool } from "../../../../shared/tools"
import { DISABLED_WEB_SEARCH_ROUTING_PLAN, HOSTED_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { ToolPromptGenerator } from "../../generators/ToolPromptGenerator"
import { getPrompt } from "../../i18n"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../../system-prompt/context"

const BASE_CONTEXT = {
	promptProfile: PromptProfile.Standard,
	providerInfo: { providerId: "openai", model: { id: "model", info: {} } },
	enableNativeToolCalls: true,
	webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN,
	terminalCommandTimeoutSeconds: 1800,
} as unknown as SystemPromptContext

/** Finds one projected tool by stable provider name. */
function findTool(tools: ReturnType<ToolPromptGenerator["generate"]>, name: string) {
	return (tools ?? []).find((tool) => {
		if ("function" in tool) return tool.function.name === name
		return "name" in tool && tool.name === name
	})
}

/** Reads the provider-neutral description from any projected tool shape. */
function toolDescription(tool: ReturnType<typeof findTool>): string | undefined {
	if (!tool) return undefined
	if ("function" in tool) return tool.function.description
	return "description" in tool ? tool.description : undefined
}

describe("provider tool projector", () => {
	it("projects canonical parameters to OpenAI schemas", () => {
		const tools = new ToolPromptGenerator().generate(PromptProfile.Standard, BASE_CONTEXT)
		const tool = findTool(tools, ClineDefaultTool.FILE_READ)

		expect(tool).toMatchObject({
			type: "function",
			function: {
				name: ClineDefaultTool.FILE_READ,
				parameters: { required: ["path"] },
			},
		})
	})

	it.each([
		[true, true],
		[false, false],
		[undefined, false],
	] as const)("projects read_file image guidance consistently for Native and XML (%s)", (supportsImages, shouldInclude) => {
		const context = {
			...BASE_CONTEXT,
			providerInfo: {
				providerId: "openai",
				model: {
					id: "model",
					info: supportsImages === undefined ? {} : { capabilities: { supportsImages } },
				},
			},
		} as unknown as SystemPromptContext
		const generator = new ToolPromptGenerator()
		const imageDescription = getPrompt("readFile", "imageSupportDescription")
		const nativeDescription = toolDescription(
			findTool(generator.generate(PromptProfile.Standard, context), ClineDefaultTool.FILE_READ),
		)
		const xmlDescription = generator.generateXml(PromptProfile.Standard, context)

		if (shouldInclude) {
			expect(nativeDescription).toContain(imageDescription)
			expect(xmlDescription).toContain(imageDescription)
		} else {
			expect(nativeDescription).not.toContain(imageDescription)
			expect(xmlDescription).not.toContain(imageDescription)
		}
	})

	it("resolves canonical runtime tokens at the native transport boundary without recursive insertion", () => {
		const context = {
			...BASE_CONTEXT,
			cwd: "/workspace/project",
			browserSettings: { viewport: { width: 1440, height: 900 }, disableToolUse: false },
			supportsBrowserUse: true,
			isMultiRootEnabled: true,
			workspaceRoots: [
				{ name: "primary", path: "/workspace/project" },
				{ name: "secondary\nworkspace", path: "/private/secondary-root" },
			],
		} as SystemPromptContext

		const tools = new ToolPromptGenerator().generate(PromptProfile.Standard, context)
		const fileTool = findTool(tools, ClineDefaultTool.FILE_READ)
		const browserTool = findTool(tools, ClineDefaultTool.BROWSER)
		const serialized = JSON.stringify([fileTool, browserTool])

		expect(serialized).toContain("Use `path` for the default workspace")
		expect(serialized).toContain("`@workspace:path`")
		expect(serialized).toContain("Available workspaces: primary, secondary workspace.")
		expect(serialized).toContain("1440x900")
		expect(serialized).not.toContain("/workspace/project")
		expect(serialized).not.toContain("/private/secondary-root")
		expect(serialized).not.toContain("@WORKSPACE_PATH_RULE@")
		expect(serialized).not.toContain("@MULTI_ROOT_HINT@")
		expect(serialized).not.toContain("@BROWSER_VIEWPORT_WIDTH@")
		expect(serialized).not.toContain("@BROWSER_VIEWPORT_HEIGHT@")
	})

	it.each([
		["openai", "function", "boolean", "integer"],
		["anthropic", "anthropic", "boolean", "integer"],
		["gemini", "gemini", "BOOLEAN", "NUMBER"],
	] as const)("projects the complete optional execute_command lifecycle for %s", (providerId, shape, boolType, intType) => {
		const context = { ...BASE_CONTEXT, providerInfo: { ...BASE_CONTEXT.providerInfo, providerId } }
		const tool = findTool(new ToolPromptGenerator().generate(PromptProfile.Standard, context), ClineDefaultTool.BASH)
		const projected = tool as unknown as {
			function?: { parameters?: unknown }
			input_schema?: unknown
			parameters?: unknown
		}
		const schema =
			shape === "function"
				? projected.function?.parameters
				: shape === "anthropic"
					? projected.input_schema
					: projected.parameters

		expect(schema).toMatchObject({
			required: ["command", "requires_approval"],
			properties: {
				workdirectory: { type: shape === "gemini" ? "STRING" : "string" },
				background: { type: boolType },
				synchronous: { type: boolType },
				timeout: { type: intType },
				mute_stdout: { type: boolType },
			},
		})
	})

	it.each([
		PromptProfile.Standard,
		PromptProfile.Lite,
	])("projects kill_command as a separate function_id-targeted tool in %s", (profile) => {
		const tool = findTool(new ToolPromptGenerator().generate(profile, BASE_CONTEXT), ClineDefaultTool.KILL_COMMAND)

		expect(tool).toMatchObject({
			type: "function",
			function: {
				name: ClineDefaultTool.KILL_COMMAND,
				parameters: {
					required: ["function_id"],
					properties: { function_id: { type: "string" } },
				},
			},
		})
	})

	it("keeps spawn_task independent from the Standard subagents feature toggle", () => {
		const context = { ...BASE_CONTEXT, subagentsEnabled: false, isSubagentRun: false }
		const tools = new ToolPromptGenerator().generate(PromptProfile.Standard, context)

		expect(findTool(tools, ClineDefaultTool.SPAWN_TASK)).toMatchObject({
			function: {
				parameters: {
					required: ["task", "mode"],
					properties: {
						mode: { type: "string", enum: ["plan", "act"] },
					},
				},
			},
		})
		expect(findTool(tools, ClineDefaultTool.USE_SUBAGENT)).toBeUndefined()
		expect(findTool(tools, ClineDefaultTool.USE_SUBAGENTS)).toBeUndefined()
	})

	it("exposes singular and parallel subagent tools only in Standard", () => {
		const context = { ...BASE_CONTEXT, subagentsEnabled: true, isSubagentRun: false }
		const standardTools = new ToolPromptGenerator().generate(PromptProfile.Standard, context)
		const liteTools = new ToolPromptGenerator().generate(PromptProfile.Lite, context)

		expect(findTool(standardTools, ClineDefaultTool.USE_SUBAGENT)).toBeDefined()
		expect(findTool(standardTools, ClineDefaultTool.USE_SUBAGENTS)).toBeDefined()
		expect(findTool(standardTools, "load_subagent")).toBeUndefined()
		expect(findTool(liteTools, ClineDefaultTool.USE_SUBAGENT)).toBeUndefined()
		expect(findTool(liteTools, ClineDefaultTool.USE_SUBAGENTS)).toBeUndefined()
	})

	it("keeps Lite free of spawn, subagent, LSP, browser, and web tools", () => {
		const tools = new ToolPromptGenerator().generate(PromptProfile.Lite, {
			...BASE_CONTEXT,
			subagentsEnabled: true,
			isSubagentRun: false,
			supportsBrowserUse: true,
			clineWebToolsEnabled: true,
		})
		const excluded = [
			ClineDefaultTool.SPAWN_TASK,
			ClineDefaultTool.USE_SUBAGENT,
			ClineDefaultTool.USE_SUBAGENTS,
			ClineDefaultTool.FIND_REFERENCES,
			ClineDefaultTool.RENAME,
			ClineDefaultTool.REPLACE_TEXT,
			ClineDefaultTool.BROWSER,
			ClineDefaultTool.WEB_FETCH,
			ClineDefaultTool.WEB_SEARCH,
		]

		for (const toolId of excluded) expect(findTool(tools, toolId)).toBeUndefined()
	})

	it("projects use_subagent with agent_name, task, and context", () => {
		const context = { ...BASE_CONTEXT, subagentsEnabled: true, isSubagentRun: false }
		const tool = findTool(new ToolPromptGenerator().generate(PromptProfile.Standard, context), ClineDefaultTool.USE_SUBAGENT)

		expect(tool).toMatchObject({
			function: {
				description: expect.stringContaining("main task's context window"),
				parameters: {
					required: ["task", "context"],
					properties: {
						agent_name: { type: "string" },
						task: { type: "string" },
						context: { type: "string", description: expect.stringContaining("modification boundary") },
						timeout: { type: "integer", description: expect.stringContaining("Defaults to 1200.") },
					},
				},
			},
		})
	})

	it.each([
		PromptProfile.Standard,
		PromptProfile.Lite,
	])("does not expose recursive task or subagent tools during a %s subagent run", (profile) => {
		const context = { ...BASE_CONTEXT, subagentsEnabled: true, isSubagentRun: true }
		const tools = new ToolPromptGenerator().generate(profile, context)

		expect(findTool(tools, ClineDefaultTool.SPAWN_TASK)).toBeUndefined()
		expect(findTool(tools, ClineDefaultTool.USE_SUBAGENT)).toBeUndefined()
		expect(findTool(tools, ClineDefaultTool.USE_SUBAGENTS)).toBeUndefined()
	})

	it("honors the explicit spawned-child disableTools guard", () => {
		const tools = new ToolPromptGenerator().generate(PromptProfile.Standard, {
			...BASE_CONTEXT,
			subagentsEnabled: false,
			isSubagentRun: false,
			disableTools: [ClineDefaultTool.SPAWN_TASK],
		})

		expect(findTool(tools, ClineDefaultTool.SPAWN_TASK)).toBeUndefined()
	})

	it("projects canonical parameters to Anthropic schemas", () => {
		const context = { ...BASE_CONTEXT, providerInfo: { ...BASE_CONTEXT.providerInfo, providerId: "anthropic" } }
		const tool = findTool(new ToolPromptGenerator().generate(PromptProfile.Standard, context), ClineDefaultTool.FILE_READ)

		expect(tool).toMatchObject({ name: ClineDefaultTool.FILE_READ, input_schema: { required: ["path"] } })
	})

	it("projects every Anthropic-protocol provider to the same input-schema shape", () => {
		// These providers post to the Anthropic Messages API, which rejects a tool
		// whose `type` is not one of its own tags. Projecting by provider name
		// alone let claude-code fall through to the OpenAI function wrapper and
		// fail upstream with `Input tag 'function' ... does not match`.
		const anthropicProtocolProviders = ["anthropic", "claude-code", "bedrock", "minimax"]
		const reference = findTool(
			new ToolPromptGenerator().generate(PromptProfile.Standard, {
				...BASE_CONTEXT,
				providerInfo: { ...BASE_CONTEXT.providerInfo, providerId: "anthropic" },
			}),
			ClineDefaultTool.FILE_READ,
		)

		for (const providerId of anthropicProtocolProviders) {
			const context = { ...BASE_CONTEXT, providerInfo: { ...BASE_CONTEXT.providerInfo, providerId } }
			const tool = findTool(new ToolPromptGenerator().generate(PromptProfile.Standard, context), ClineDefaultTool.FILE_READ)

			expect(tool, providerId).toEqual(reference)
			expect(tool, providerId).not.toHaveProperty("type", "function")
			expect(tool, providerId).not.toHaveProperty("function")
		}
	})

	it("includes dependency-gated parameters only when their tool dependency is enabled", () => {
		const enabledContext = { ...BASE_CONTEXT, focusChainSettings: { enabled: true, remindClineInterval: 6 } }
		const disabledContext = { ...BASE_CONTEXT, focusChainSettings: { enabled: false, remindClineInterval: 6 } }

		const enabledTool = findTool(
			new ToolPromptGenerator().generate(PromptProfile.Standard, enabledContext),
			ClineDefaultTool.FILE_READ,
		)
		const disabledTool = findTool(
			new ToolPromptGenerator().generate(PromptProfile.Standard, disabledContext),
			ClineDefaultTool.FILE_READ,
		)

		expect(enabledTool).toMatchObject({ function: { parameters: { properties: { task_progress: {} } } } })
		expect(disabledTool).not.toMatchObject({ function: { parameters: { properties: { task_progress: {} } } } })
	})

	it("projects the original Native focus guidance and task_progress only when enabled", () => {
		const profile = PromptProfile.Standard
		const enabledContext = {
			...BASE_CONTEXT,
			promptProfile: profile,
			focusChainSettings: { enabled: true, remindClineInterval: 6 },
		}
		const disabledContext = {
			...enabledContext,
			focusChainSettings: { enabled: false, remindClineInterval: 6 },
		}
		const generator = new ToolPromptGenerator()
		const enabledAttempt = findTool(generator.generate(profile, enabledContext), ClineDefaultTool.ATTEMPT)
		const disabledAttempt = findTool(generator.generate(profile, disabledContext), ClineDefaultTool.ATTEMPT)

		expect(enabledAttempt).not.toMatchObject({ function: { parameters: { properties: { task_progress: {} } } } })
		expect(disabledAttempt).not.toMatchObject({ function: { parameters: { properties: { task_progress: {} } } } })

		for (const toolId of [ClineDefaultTool.MAKE_PLAN, ClineDefaultTool.STATUS_UPDATE]) {
			const enabled = findTool(generator.generate(profile, enabledContext), toolId)
			const disabled = findTool(generator.generate(profile, disabledContext), toolId)

			expect(enabled).toMatchObject({ function: { parameters: { properties: { task_progress: {} } } } })
			expect(disabled).not.toMatchObject({ function: { parameters: { properties: { task_progress: {} } } } })
		}

		const enabledPlan = findTool(generator.generate(profile, enabledContext), ClineDefaultTool.MAKE_PLAN)
		expect(enabledPlan).toMatchObject({
			function: {
				name: "make_plan",
				parameters: {
					properties: { needs_more_exploration: { type: "boolean" } },
				},
			},
		})
	})

	it("keeps Lite free of focus guidance and task_progress even when the caller enables focus", () => {
		const context = {
			...BASE_CONTEXT,
			promptProfile: PromptProfile.Lite,
			focusChainSettings: { enabled: true, remindClineInterval: 6 },
		}
		const tools = new ToolPromptGenerator().generate(PromptProfile.Lite, context)

		expect(JSON.stringify(tools)).not.toContain("task_progress")
		expect(JSON.stringify(tools)).not.toContain("change_todo_list")
	})

	it("does not project the local web_search function for a hosted request", () => {
		const context = {
			...BASE_CONTEXT,
			clineWebToolsEnabled: true,
			webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN,
		}
		const tools = new ToolPromptGenerator().generate(PromptProfile.Standard, context)

		expect(findTool(tools, ClineDefaultTool.WEB_FETCH)).toBeDefined()
		expect(findTool(tools, ClineDefaultTool.WEB_SEARCH)).toBeUndefined()
	})

	it("appends enabled MCP schemas only to Native", () => {
		const context = {
			...BASE_CONTEXT,
			mcpHub: {
				getServers: () => [
					{
						uid: "srv",
						name: "server",
						config: "{}",
						status: "connected" as const,
						tools: [
							{
								name: "weather",
								description: "Weather",
								inputSchema: {
									type: "object",
									properties: {
										city: { type: "string", description: "City", enum: ["Paris", "Tokyo"] },
										options: {
											type: "object",
											properties: { units: { type: "string", enum: ["metric", "imperial"] } },
										},
									},
									required: ["city"],
								},
							},
						],
					},
				],
			},
		} as SystemPromptContext

		const nativeTools = new ToolPromptGenerator().generate(PromptProfile.Standard, context)
		const liteTools = new ToolPromptGenerator().generate(PromptProfile.Lite, context)

		expect(findTool(nativeTools, "srv0mcp0weather")).toMatchObject({
			function: {
				parameters: {
					required: ["city"],
					properties: {
						city: { enum: ["Paris", "Tokyo"] },
						options: { properties: { units: { enum: ["metric", "imperial"] } } },
					},
				},
			},
		})
		expect(findTool(liteTools, "srv0mcp0weather")).toBeUndefined()
	})

	it("projects canonical parameters to Gemini declarations", () => {
		const context = { ...BASE_CONTEXT, providerInfo: { ...BASE_CONTEXT.providerInfo, providerId: "gemini" } }
		const tool = findTool(new ToolPromptGenerator().generate(PromptProfile.Standard, context), ClineDefaultTool.FILE_READ)

		expect(tool).toMatchObject({
			name: ClineDefaultTool.FILE_READ,
			parameters: { required: ["path"] },
		})
	})

	it.each([
		[GPT_IMAGE_2_MODEL_ID, "gptImage2SizingDescription"],
		[GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID, "gptImage2SubscriptionSizingDescription"],
		[GPT_IMAGE_1_MODEL_ID, "gptImage1SizingDescription"],
		[undefined, undefined],
	] as const)("keeps only the bound image model sizing guidance for Native and XML (%s)", (imageModelId, keptPromptKey) => {
		const context = {
			...BASE_CONTEXT,
			imageGenerationAvailable: true,
			imageModelId,
		} as unknown as SystemPromptContext
		const generator = new ToolPromptGenerator()
		const sizingPromptKeys = [
			"gptImage2SizingDescription",
			"gptImage2SubscriptionSizingDescription",
			"gptImage1SizingDescription",
		] as const
		const nativeDescription = toolDescription(
			findTool(generator.generate(PromptProfile.Standard, context), ClineDefaultTool.GENERATE_IMAGE),
		)
		const xmlDescription = generator.generateXml(PromptProfile.Standard, context)

		expect(nativeDescription).toContain(getPrompt("generateImage", "standardDescription"))
		for (const promptKey of sizingPromptKeys) {
			const sizingText = getPrompt("generateImage", promptKey)
			if (promptKey === keptPromptKey) {
				expect(nativeDescription).toContain(sizingText)
				expect(xmlDescription).toContain(sizingText)
			} else {
				expect(nativeDescription).not.toContain(sizingText)
				expect(xmlDescription).not.toContain(sizingText)
			}
		}
	})
})
