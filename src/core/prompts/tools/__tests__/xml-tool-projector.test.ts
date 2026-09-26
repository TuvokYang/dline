import { describe, expect, it } from "vitest"
import { toolParamNames } from "../../../assistant-message"
import { SystemPromptGenerator } from "../../generators/SystemPromptGenerator"
import { ToolPromptGenerator } from "../../generators/ToolPromptGenerator"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../../system-prompt/context"
import { STANDARD_TOOL_SPECS } from "../tool-specs"

const BASE_CONTEXT = {
	promptProfile: PromptProfile.Standard,
	cwd: "/workspace/project",
	ide: "Test IDE",
	providerInfo: {
		providerId: "openai",
		model: { id: "tool-matrix", info: { id: "tool-matrix", capabilities: {} } },
		mode: "act",
	},
	enableNativeToolCalls: false,
	supportsBrowserUse: true,
	browserSettings: { viewport: { width: 1440, height: 900 }, disableToolUse: false },
	isMultiRootEnabled: true,
	workspaceRoots: [
		{ name: "primary", path: "/workspace/project" },
		{ name: "secondary\tworkspace", path: "/private/secondary-root" },
	],
	focusChainSettings: { enabled: false, remindClineInterval: 0 },
	terminalCommandTimeoutSeconds: 1800,
	isTesting: true,
} as SystemPromptContext

describe("XML tool projection", () => {
	it("keeps every canonical parameter recognizable by the XML parser", () => {
		const parserParams = new Set<string>(toolParamNames)
		const missingParams = [
			...new Set(STANDARD_TOOL_SPECS.flatMap((tool) => tool.parameters?.map((parameter) => parameter.name) ?? [])),
		].filter((name) => !parserParams.has(name))

		expect(missingParams).toEqual([])
	})

	it("keeps canonical runtime tokens unresolved until the System facade final scan", async () => {
		const generator = new ToolPromptGenerator()
		const xml = generator.generateXml(PromptProfile.Standard, BASE_CONTEXT)

		expect(xml).toContain("@WORKSPACE_PATH_RULE@")
		expect(xml).toContain("@MULTI_ROOT_HINT@")
		expect(xml).toContain("@BROWSER_VIEWPORT_WIDTH@x@BROWSER_VIEWPORT_HEIGHT@")
		expect(xml).not.toContain("@CWD@")
		expect(xml).not.toContain("/workspace/project")
		expect(xml).not.toContain("/private/secondary-root")
		expect(xml).not.toContain("1440x900")
		expect(xml).not.toContain("{{")

		const output = await new SystemPromptGenerator(generator).generate(BASE_CONTEXT)

		expect(output.systemPrompt).toContain("Workspace Names:\n- primary\n- secondary workspace")
		expect(output.systemPrompt).toContain("1440x900")
		expect(output.systemPrompt).not.toContain("/workspace/project")
		expect(output.systemPrompt).not.toContain("/private/secondary-root")
		expect(output.systemPrompt).not.toContain("@WORKSPACE_PATH_RULE@")
		expect(output.systemPrompt).not.toContain("@MULTI_ROOT_HINT@")
		expect(output.systemPrompt).not.toContain("@BROWSER_VIEWPORT_WIDTH@")
		expect(output.systemPrompt).not.toContain("@BROWSER_VIEWPORT_HEIGHT@")
		expect(output.systemPrompt).toContain("default is 1800 seconds")
		expect(output.systemPrompt).not.toContain("@TERMINAL_COMMAND_TIMEOUT_SECONDS@")
		expect(output.systemPrompt).not.toContain("{{")
	})
})
