import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"

import { englishTemplateStore } from "../../i18n/en"
import { createPromptGroup } from "../../i18n/helpers/create-pack"
import { definePromptModule } from "../../i18n/helpers/define-module"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../../system-prompt/context"
import { PromptScanner } from "../../template/PromptScanner"
import { TemplateStore, TemplateStoreError } from "../../template/TemplateStore"
import { CommandPromptGenerator } from "../CommandPromptGenerator"
import { RuntimePromptGenerator } from "../RuntimePromptGenerator"
import { ToolPromptGenerator } from "../ToolPromptGenerator"

const TEMPLATE_OPEN = "$" + "{"

const TEST_MODULE = definePromptModule({
	name: "generatorTest",
	domain: "commands",
	prompts: {
		command: "Command @VALUE@",
		runtime: `literal=$HOME $content "${TEMPLATE_OPEN}request.params.uri}" value=@VALUE@`,
		missing: "Missing @VALUE@ and @OTHER@",
	},
	contracts: {
		command: {
			variables: {
				VALUE: { stages: ["runtime"], required: true },
			},
		},
		runtime: {
			variables: {
				VALUE: { stages: ["runtime"], required: true },
			},
		},
		missing: {
			variables: {
				VALUE: { stages: ["runtime"], required: true },
				OTHER: { stages: ["runtime"], required: true },
			},
		},
	},
	source: "test/generator-test.ts",
})

/** Creates an isolated static store for generator tests. */
function createStore(): TemplateStore {
	return TemplateStore.create(createPromptGroup("commands", TEST_MODULE))
}

describe("CommandPromptGenerator", () => {
	it("loads an exact template and applies runtime env", () => {
		const output = new CommandPromptGenerator(createStore()).generate("generatorTest.command", { VALUE: "ready" })

		expect(output.text).toBe("Command ready")
		expect(output.warnings).toEqual([])
		expect(output.trace).toEqual([{ key: "VALUE", stage: "runtime", source: "command-generator" }])
	})

	it("performs exactly one final scan for one complete command template", () => {
		const renderSpy = vi.spyOn(PromptScanner.prototype, "render")

		try {
			new CommandPromptGenerator(createStore()).generate("generatorTest.command", { VALUE: "ready" })
			expect(renderSpy).toHaveBeenCalledTimes(1)
		} finally {
			renderSpy.mockRestore()
		}
	})

	it("preserves missing template errors", () => {
		const generator = new CommandPromptGenerator(createStore())

		expect(() => generator.generate("generatorTest.absent", {})).toThrowError(TemplateStoreError)
		expect(() => generator.generate("generatorTest.absent", {})).toThrowError(
			expect.objectContaining({ reason: "missing-template", templateId: "generatorTest.absent" }),
		)
	})
})

describe("ToolPromptGenerator", () => {
	const context = {
		promptProfile: PromptProfile.Standard,
		providerInfo: { providerId: "openai", model: { id: "model", info: {} } },
		enableNativeToolCalls: true,
	} as SystemPromptContext

	it("performs exactly one final scan for the complete native descriptor projection", () => {
		const renderSpy = vi.spyOn(PromptScanner.prototype, "render")

		try {
			new ToolPromptGenerator().generate(PromptProfile.Standard, context)
			expect(renderSpy).toHaveBeenCalledTimes(1)
		} finally {
			renderSpy.mockRestore()
		}
	})

	it("keeps XML descriptor fragments unresolved without prompt generation", () => {
		const renderSpy = vi.spyOn(PromptScanner.prototype, "render")

		try {
			new ToolPromptGenerator().generateXml(PromptProfile.Standard, { ...context, enableNativeToolCalls: false })
			expect(renderSpy).not.toHaveBeenCalled()
		} finally {
			renderSpy.mockRestore()
		}
	})

	it.each([
		PromptProfile.Standard,
		PromptProfile.Lite,
	])("does not expose explicit control instructions in the %s native defaults", (profile) => {
		const tools = new ToolPromptGenerator().generate(profile, { ...context, promptProfile: profile }) ?? []
		const names = tools.flatMap((tool) =>
			"function" in tool && tool.function?.name
				? [tool.function.name]
				: "name" in tool && typeof tool.name === "string"
					? [tool.name]
					: [],
		)

		expect(names).not.toContain(ClineDefaultTool.SUMMARIZE_TASK)
		expect(names).not.toContain(ClineDefaultTool.NEW_TASK)
		expect(names).not.toContain(ClineDefaultTool.CONDENSE)
		expect(names).not.toContain(ClineDefaultTool.NEW_RULE)
		expect(names).not.toContain(ClineDefaultTool.REPORT_BUG)
		expect(names).not.toContain(ClineDefaultTool.GENERATE_EXPLANATION)
	})

	it("exposes load_skill as the only Skill loading tool in Standard native projections", () => {
		const tools = new ToolPromptGenerator().generate(PromptProfile.Standard, {
			...context,
			skills: [{ name: "review", description: "Review code", path: "/skills/review/SKILL.md", source: "project" }],
		})
		const names = (tools ?? []).flatMap((tool) =>
			"function" in tool && tool.function?.name
				? [tool.function.name]
				: "name" in tool && typeof tool.name === "string"
					? [tool.name]
					: [],
		)

		expect(names).toContain("load_skill")
		expect(names).not.toContain("use_skill")
	})

	it("keeps explicit compaction instructions on the stable cached native projection", () => {
		const generator = new ToolPromptGenerator()
		const defaultTools = generator.generate(PromptProfile.Standard, context) ?? []
		const staleTools = [
			...defaultTools,
			{ type: "function", function: { name: ClineDefaultTool.SUMMARIZE_TASK } },
		] as typeof defaultTools
		const compactRequestTools = generator.generateToolsForRequest(PromptProfile.Standard, context, staleTools)

		expect(compactRequestTools).toEqual(defaultTools)
		expect(compactRequestTools).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ function: expect.objectContaining({ name: ClineDefaultTool.SUMMARIZE_TASK }) }),
			]),
		)
	})

	it("filters retired use_skill schemas from frozen native projections", () => {
		const generator = new ToolPromptGenerator()
		const staleTools = [
			{ type: "function", function: { name: "use_skill" } },
			{ type: "function", function: { name: ClineDefaultTool.LOAD_SKILL } },
		] as NonNullable<ReturnType<ToolPromptGenerator["generate"]>>

		const selected = generator.generateToolsForRequest(PromptProfile.Standard, context, staleTools)
		const names = (selected ?? []).flatMap((tool) =>
			"function" in tool && tool.function?.name
				? [tool.function.name]
				: "name" in tool && typeof tool.name === "string"
					? [tool.name]
					: [],
		)

		expect(names).toEqual([ClineDefaultTool.LOAD_SKILL])
	})
})

describe("RuntimePromptGenerator", () => {
	it("preserves literal dollar text and does not rescan inserted values", () => {
		const output = new RuntimePromptGenerator(createStore()).generate("generatorTest.runtime", {
			VALUE: `opaque @OTHER@ $HOME ${TEMPLATE_OPEN}request.params.uri}`,
		})

		expect(output.text).toBe(
			`literal=$HOME $content "${TEMPLATE_OPEN}request.params.uri}" value=opaque @OTHER@ $HOME ${TEMPLATE_OPEN}request.params.uri}`,
		)
		expect(output.warnings).toEqual([])
	})

	it("retains missing tokens and returns structured warnings", () => {
		const output = new RuntimePromptGenerator(createStore()).generate("generatorTest.missing", { VALUE: "ready" })

		expect(output.text).toBe("Missing ready and @OTHER@")
		expect(output.warnings).toEqual([
			expect.objectContaining({
				templateId: "generatorTest.missing",
				key: "OTHER",
				loadedStages: ["runtime"],
			}),
		])
	})

	it("preserves MCP URI templates and JavaScript template literals", () => {
		const output = new RuntimePromptGenerator(englishTemplateStore).generate("loadMcpDocumentation.main", {
			MCP_SERVERS_PATH: "C:/mcp",
			MCP_SETTINGS_FILE_PATH: "C:/settings.json",
			CONNECTED_SERVERS: "weather",
		})

		expect(output.text).toContain("C:/mcp")
		expect(output.text).toContain("C:/settings.json")
		expect(output.text).toContain("below: weather")
		expect(output.text).toContain("weather://{city}/current")
		expect(output.text).toContain(`${TEMPLATE_OPEN}request.params.uri}`)
		expect(output.text).toContain(`${TEMPLATE_OPEN}request.params.name}`)
		expect(output.text).toContain(`Weather API error: ${TEMPLATE_OPEN}`)
		expect(output.warnings).toEqual([])
	})
})
